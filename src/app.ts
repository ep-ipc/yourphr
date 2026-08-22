/**
 * The assembly (yourphr#582; the last Phase-4 item of yourphr#542): every proven module behind one
 * HTTP layer, one process, in the only order that works —
 *
 *   config -> migrations -> auth (+ bootstrap) -> catalog (+ seed) -> sources/worker -> server
 *
 * Config first because everything reads it; migrations before any store opens for business (their
 * ledger is the schema's truth); bootstrap after auth exists so an empty install gets its admin;
 * seeding after the catalog exists and never clobbering operator edits; the worker last, because
 * it must find everything else standing.
 *
 * Roles (yourphr#597): the admin gate reads `auth_users.role`. The bootstrap account is created
 * 'admin', imported Go accounts carry Go's role, and the migration below translates the earlier
 * "the account named admin is the admin" simplification (yourphr#582) into data for installs that
 * predate the column — so the bootstrap admin keeps working and nobody is silently demoted.
 *
 * openStores() is the first half of that order, factored out so the migration tool (yourphr#586)
 * opens EXACTLY the stores the server opens — same files, same key, same per-user repository seam.
 * A tool with its own idea of where the data lives is how a migration lands in the wrong place and
 * reports success.
 */
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { ConfigStore, envNameFor, type ConfigValue } from './config/index.js';
import { addColumnWithDefault, runMigrations, type Migration } from './migrations/index.js';
import { UsersManager } from './framework/managers/UsersManager.js';
import { SessionsManager } from './framework/managers/SessionsManager.js';
import { SqliteUsersProvider } from './framework/providers/SqliteUsersProvider.js';
import { PasswordAuthProvider } from './framework/providers/PasswordAuthProvider.js';
import { ProviderCatalog, catalogEntryShape, connectableShape, connectionPolicy, type CatalogEntry, type CatalogWrite } from './catalog/index.js';
import { Engine } from './framework/Engine.js';
import { ConfigurationManager } from './framework/ConfigurationManager.js';
import { ApiContext } from './framework/ApiContext.js';
import { RecordsManager } from './app/managers/RecordsManager.js';
import { SqliteRecordsProvider } from './app/providers/SqliteRecordsProvider.js';
import { SmartClient, generateVerifier } from './smart/index.js';
import { resourceTypesFromScopes } from './migrate/index.js';
import { randomUUID } from 'node:crypto';
import { SourceStore, runSyncPass, syncSource, type ConnectedSource, type JobSummary } from './worker/index.js';
import { EventBus } from './events/index.js';
import { FavoriteStore } from './favorites/index.js';
import { AccountStore, accessCategoryFor, providerRequiresLegalConsent } from './account/index.js';
import { loadLegalDocument, parseLegalKind } from './legal/index.js';
import { AdminOps, applyStagedRestore } from './admin/index.js';
import { appLog, VALID_LEVELS } from './log/index.js';
import { basename } from 'node:path';
import { backupDatabase } from './backup/index.js';
import { createYourPhrServer, toResourceFhir } from './server.js';
import { SqliteFhirRepository } from './SqliteFhirRepository.js';
import { randomBytes } from 'node:crypto';

/**
 * The app-level registry. Module constructors keep their CREATE IF NOT EXISTS as idempotent
 * double-safety; the ledger is still written here so the downgrade refusal has something to stand
 * on from the first boot.
 */
const APP_MIGRATIONS: Migration[] = [
  {
    id: '20260820200000',
    description: 'assembly baseline — module schemas owned by their constructors, ledger established',
    up: () => undefined,
  },
  {
    id: '20260822090000',
    description: 'auth_users.role (yourphr#597) — the admin gate reads a column; the account named admin, which WAS the admin until now, is recorded as one',
    up: (db) => {
      // Frozen pre-role shape: on a fresh database the table does not exist yet (the constructor
      // would create it, with the column, a step later) — create it here so ADD COLUMN has a table.
      db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        token_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`);
      const columns = (db.pragma('table_info(auth_users)') as { name: string }[]).map((c) => c.name);
      if (!columns.includes('role')) {
        addColumnWithDefault(db, 'auth_users', 'role', 'TEXT', 'user');
      }
      db.exec(`UPDATE auth_users SET role = 'admin' WHERE username = 'admin'`);
    },
  },
  {
    id: '20260822120000',
    description: 'connected_sources.platform_type + environment (yourphr#594) — what the Sources page names and groups by; unknown for rows that predate the columns',
    up: (db) => {
      // Frozen pre-column shape, so ADD COLUMN has a table on a fresh database (the constructor
      // creates it, with the columns, a step later).
      db.exec(`CREATE TABLE IF NOT EXISTS connected_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        display TEXT NOT NULL,
        fhir_base_url TEXT NOT NULL,
        token_url TEXT NOT NULL,
        client_id TEXT NOT NULL,
        patient TEXT NOT NULL,
        resource_types TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_sync_at INTEGER NOT NULL DEFAULT 0
      )`);
      const columns = (db.pragma('table_info(connected_sources)') as { name: string }[]).map((c) => c.name);
      if (!columns.includes('platform_type')) addColumnWithDefault(db, 'connected_sources', 'platform_type', 'TEXT', '');
      if (!columns.includes('environment')) addColumnWithDefault(db, 'connected_sources', 'environment', 'TEXT', '');
    },
  },
  {
    id: '20260822150000',
    description: 'provider_catalog.platform_type + brand_logo_url + consent_policy + pre_connect_profile (yourphr#603) — what the admin page writes and the connection policy reads',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS provider_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display TEXT NOT NULL UNIQUE,
        environment TEXT NOT NULL,
        fhir_base_url TEXT NOT NULL,
        scopes TEXT NOT NULL,
        client_id TEXT NOT NULL DEFAULT '',
        client_secret TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        authorize_url_override TEXT NOT NULL DEFAULT ''
      )`);
      const columns = (db.pragma('table_info(provider_catalog)') as { name: string }[]).map((c) => c.name);
      for (const column of ['platform_type', 'brand_logo_url', 'consent_policy', 'pre_connect_profile']) {
        if (!columns.includes(column)) addColumnWithDefault(db, 'provider_catalog', column, 'TEXT', '');
      }
    },
  },
];

/** Everything that owns data, opened the one way the server opens it. */
export interface Stores {
  config: ConfigStore;
  db: InstanceType<typeof Database>;
  /** '' when the database is unencrypted. */
  dbKey: string;
  users: UsersManager;
  sessions: SessionsManager;
  catalog: ProviderCatalog;
  sources: SourceStore;
  favorites: FavoriteStore;
  account: AccountStore;
  /** The composition root (yourphr#608): managers, in validated boot order. */
  engine: Engine;
  /** The one door to records (yourphr#609). */
  records: RecordsManager;
  /** The PHI-storage provider — for the migration tool's verification gate, which reads below the manager on purpose. */
  recordsProvider: SqliteRecordsProvider;
  close: () => Promise<void>;
}

export async function openStores(dataDir: string, env: Record<string, string | undefined> = process.env): Promise<Stores> {
  // 1. Config — everything below reads it.
  const config = new ConfigStore(dataDir, undefined, env);
  const unknown = config.unknownKeys();
  if (unknown.length > 0) {
    appLog.warn(`config: keys with no effect: ${unknown.join(', ')}`); // yourphr#473 — reported, not dropped
  }

  // 2. The app database + migrations before anything opens for business.
  const dbKey = config.getString('database.encryption.key');
  const engine = new Engine();
  const engineRef = (): Engine => engine;
  applyStagedRestore(dataDir, config.getString('database.location'), (line) => appLog.info(line)); // yourphr#602: a staged restore lands before anything opens
  const db = new Database(join(dataDir, config.getString('database.location')));
  if (dbKey !== '') {
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key='${dbKey.replace(/'/g, "''")}'`);
  }
  runMigrations(db, APP_MIGRATIONS);

  // 4. Catalog and 5. sources + per-user repositories — the same seam the HTTP layer and worker share.
  const catalog = new ProviderCatalog(db);
  const sources = new SourceStore(db);
  const favorites = new FavoriteStore(db);
  const account = new AccountStore(db);
  // 3. Accounts and sessions as managers over providers (yourphr#611): user storage in the app
  // database, passwords by the scrypt provider, the factor list from configuration.
  const users = new UsersManager(engineRef(), new SqliteUsersProvider(db), new PasswordAuthProvider(), account);
  const sessions = new SessionsManager(engineRef(), [new PasswordAuthProvider()], {
    sessionKey: randomBytes(32),
    session: { slidingSeconds: config.getInt('auth.session.sliding-seconds'), absoluteSeconds: config.getInt('auth.session.absolute-seconds') },
    throttle: { maxFailures: config.getInt('auth.throttle.max-failures'), windowSeconds: config.getInt('auth.throttle.window-seconds') },
    trustedProxies: config.getStringList('auth.trusted-proxies'),
    factors: config.getStringList('auth.factors'),
  });
  // 6. The engine: managers in validated dependency order (yourphr#608). Configuration first,
  // then Records over the PHI-storage provider. The other stores join as their own children land.
  const recordsProvider = new SqliteRecordsProvider(join(dataDir, 'records.db'), dbKey === '' ? undefined : dbKey);
  engine.register('configuration', new ConfigurationManager(engine, config));
  engine.register('users', users);
  engine.register('sessions', sessions);
  engine.register('records', new RecordsManager(engine, recordsProvider));
  await engine.initialize();
  appLog.info(`engine: ${engine.registered.join(' -> ')}`);

  return {
    config, db, dbKey, users, sessions, catalog, sources, favorites, account, engine, records: engine.managers.records, recordsProvider,
    close: async () => {
      await engine.shutdown();
      db.close();
    },
  };
}

/**
 * A recorded sync job in the shape of Go's BackgroundJob + BackgroundJobSyncData (yourphr#593), which
 * is what the Angular shell and /background-jobs read. Only what the row holds: the job id is the
 * row id, the user is the caller (the join proved ownership), and a recorded job is DONE or FAILED —
 * never READY/LOCKED, because this stack records outcomes, not a queue. brand_id is empty (no brand
 * here), the summary carries the counts the worker kept.
 */
export function backgroundJobShape(job: JobSummary, username: string): Record<string, unknown> {
  const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
  const done = job.outcome === 'success';
  return {
    id: String(job.id ?? ''),
    created_at: iso(job.startedAt),
    updated_at: iso(job.finishedAt),
    user_id: username,
    job_type: 'SYNC',
    job_status: done ? 'STATUS_DONE' : 'STATUS_FAILED',
    locked_time: iso(job.startedAt),
    done_time: iso(job.finishedAt),
    retries: 0,
    data: {
      source_id: `source-${job.sourceId}`,
      brand_id: '',
      ...(job.error ? { error_data: { error: job.error } } : {}),
      summary: {
        outcome: done ? 'success' : 'failed',
        duration_ms: Math.max(0, job.finishedAt - job.startedAt) * 1000,
        total_resources: job.received,
        ...(job.error ? { error_message: job.error } : {}),
      },
    },
  };
}

/**
 * A connected source in the shape of Go's SourceCredential (yourphr#594) — what the Sources page,
 * Explore and the dashboard read. The public id is `source-<n>`, the same string every record of
 * that source carries in its source_id column, so /explore/:source and ?sourceID line up. Secrets
 * are Go's "[REDACTED]" when present and '' when the source is disconnected; fields this stack does
 * not hold (brand, portal, created_at; platform_type and environment when the row has none) are
 * absent, not invented — the Angular code already defaults every one of them.
 */
export function sourceShape(source: ConnectedSource, latestJob: JobSummary | undefined): Record<string, unknown> {
  const redact = (secret: string): string => (secret === '' ? '' : '[REDACTED]');
  return {
    id: `source-${source.id}`,
    ...(source.lastSyncAt > 0 ? { updated_at: new Date(source.lastSyncAt * 1000).toISOString() } : {}),
    user_id: source.userId,
    display: source.display,
    ...(source.platformType !== '' ? { platform_type: source.platformType } : {}),
    ...(source.environment !== '' ? { environment: source.environment } : {}),
    patient: source.patient,
    client_id: source.clientId,
    api_endpoint_base_url: source.fhirBaseUrl,
    access_token: redact(source.accessToken),
    refresh_token: redact(source.refreshToken),
    expires_at: source.expiresAt,
    ...(latestJob ? { latest_background_job: backgroundJobShape(latestJob, source.userId) } : {}),
  };
}

export interface App {
  server: ReturnType<typeof createYourPhrServer>;
  engine: Engine;
  config: ConfigStore;
  users: UsersManager;
  sessions: SessionsManager;
  catalog: ProviderCatalog;
  sources: SourceStore;
  account: AccountStore;
  bootstrapPasswordFile?: string;
  syncNow: (now?: number) => Promise<unknown>;
  backupNow: () => Promise<unknown>;
  close: () => Promise<void>;
}

export async function assembleApp(dataDir: string, options: { seeds?: CatalogWrite[]; env?: Record<string, string | undefined>; workerIntervalMs?: number; webDir?: string; version?: string } = {}): Promise<App> {
  const stores = await openStores(dataDir, options.env ?? process.env);
  const { config, users, sessions, catalog, sources, favorites, account, engine, records } = stores;
  /** The worker and the migration tool act for an account as a named system principal. */
  const systemCtx = (name: string, username: string): ApiContext => ApiContext.system(name, username, engine);

  // Bootstrap the first admin on an empty install — after the managers exist, before anything serves.
  const bootstrap = await users.bootstrapAdmin(dataDir);

  // Provision-then-preserve.
  if (options.seeds) {
    catalog.seed(options.seeds);
  }

  const workerDeps = {
    store: sources,
    writerFor: (userId: string, sourceId: string) => records.writer(systemCtx('worker', userId), sourceId),
    maxPages: config.getInt('sync.max-pages'),
    allowInternal: (options.env ?? process.env)['SPIKE_TEST_ALLOW_INTERNAL'] === '1',
  };
  const timer = options.workerIntervalMs
    ? setInterval(() => { void runSyncPass(workerDeps); }, options.workerIntervalMs)
    : undefined;
  timer?.unref?.();

  const adminOps = new AdminOps({ dataDir, config, appDb: stores.db, sources, records });
  const backupNow = () => adminOps.backupNow();
  // The scheduler (yourphr#602): once a minute, is a backup due? Outcome recorded by backupNow.
  let lastScheduledMinute: string | undefined;
  const scheduleTimer = options.workerIntervalMs === undefined ? undefined : setInterval(() => {
    const now = new Date();
    if (!adminOps.scheduleDue(now, lastScheduledMinute)) return;
    lastScheduledMinute = now.toISOString().slice(0, 16);
    adminOps.backupNow().then(
      (r) => appLog.info(`scheduled backup written: ${r.file} (${r.sizeBytes} bytes)`),
      (err: Error) => appLog.error(`scheduled backup failed: ${err.message}`)
    );
  }, 60_000);
  scheduleTimer?.unref?.();

  // The instance keys Go publishes that this stack has a value for. A key this stack does not have
  // (theme, demo, signup, the wider password policy) is ABSENT, and the Angular app's mapper already
  // defaults an absent key — nothing is invented to fill Go's list.
  const publicInstanceKeys = (): Record<string, unknown> => ({
    'operator.name': config.getString('operator.name'),
    'operator.contact_url': config.getString('operator.contact_url'),
    'password.min_length': config.getInt('auth.password.min-length'),
  });

  const events = new EventBus();

  /** The keys /api/instance/public publishes — Go's `public` list, as far as this stack has values. */
  const PUBLIC_KEYS = new Set(['operator.name', 'operator.contact_url', 'auth.password.min-length']);

  const withStatus = (status: number, message: string): Error & { status: number } => Object.assign(new Error(message), { status });

  const catalogById = (publicId: string): CatalogEntry | undefined => (/^\d+$/.test(publicId) ? catalog.byId(Number(publicId)) : undefined);
  const enabledCatalogEntry = (publicId: string): CatalogEntry => {
    const e = catalogById(publicId);
    if (!e || !e.enabled) throw withStatus(404, 'no such enabled catalog entry');
    return e;
  };
  /** Go's providerCatalogRequest -> a CatalogWrite; an update keeps what the body does not say. */
  const catalogWriteFrom = (body: Record<string, unknown>, existing?: CatalogEntry): CatalogWrite => {
    const str = (k: string, fallback = ''): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : fallback);
    const environment = str('environment', existing?.environment ?? 'production') === 'sandbox' ? 'sandbox' : 'production';
    return {
      display: str('display', existing?.display ?? ''),
      environment,
      fhirBaseUrl: str('api_endpoint_base_url', existing?.fhirBaseUrl ?? ''),
      scopes: str('scopes', existing?.scopes ?? ''),
      clientId: str('client_id', existing?.clientId ?? ''),
      clientSecret: str('client_secret'),
      enabled: typeof body['enabled'] === 'boolean' ? (body['enabled'] as boolean) : existing?.enabled ?? false,
      authorizeUrlOverride: str('authorize_url_override', existing?.authorizeUrlOverride ?? ''),
      platformType: str('platform_type', existing?.platformType ?? '') || 'ehr',
      brandLogoUrl: str('brand_logo_url', existing?.brandLogoUrl ?? ''),
      consentPolicy: str('consent_policy', existing?.consentPolicy ?? ''),
      preConnectProfile: str('pre_connect_profile', existing?.preConnectProfile ?? ''),
      allowInternal: (options.env ?? process.env)['SPIKE_TEST_ALLOW_INTERNAL'] === '1',
    };
  };
  const smartClientFor = (e: CatalogEntry, redirectUri: string): SmartClient =>
    new SmartClient({
      fhirBaseUrl: e.fhirBaseUrl, clientId: e.clientId, clientSecret: catalog.clientSecretFor(e.id) || undefined,
      redirectUri, scopes: e.scopes.split(/\s+/).filter(Boolean),
      allowInternal: (options.env ?? process.env)['SPIKE_TEST_ALLOW_INTERNAL'] === '1',
    });

  /** Go's AdminMetricsResponse over sync_jobs: no scrape endpoint here, counters from the job history. */
  const adminMetrics = (): Record<string, unknown> => {
    const bySource = new Map(sources.list().map((s) => [s.id, s]));
    const jobs = stores.db.prepare('SELECT * FROM sync_jobs ORDER BY id DESC').all() as { id: number; source_id: number; outcome: string; received: number; error: string; started_at: number; finished_at: number }[];
    const jobsTotal: Record<string, number> = {};
    const resourcesTotal: Record<string, number> = {};
    let durationCount = 0;
    let durationSum = 0;
    for (const j of jobs) {
      const s = bySource.get(j.source_id);
      const key = `${j.outcome === 'success' ? 'success' : 'failed'}|${s?.platformType || 'unknown'}|${s?.environment || 'unknown'}`;
      jobsTotal[key] = (jobsTotal[key] ?? 0) + 1;
      resourcesTotal[key] = (resourcesTotal[key] ?? 0) + j.received;
      durationCount++;
      durationSum += Math.max(0, j.finished_at - j.started_at);
    }
    const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
    return {
      scrape_enabled: false,
      scrape_path: '/metrics',
      scrape_note: 'This stack exposes no Prometheus scrape endpoint; the counters below come from the sync job history.',
      process: { jobs_total: jobsTotal, resources_total: resourcesTotal, duration_count: durationCount, duration_sum_seconds: durationSum },
      recent_jobs: jobs.slice(0, 10).map((j) => ({
        id: String(j.id),
        job_status: j.outcome === 'success' ? 'STATUS_DONE' : 'STATUS_FAILED',
        created_at: iso(j.started_at),
        done_time: iso(j.finished_at),
        source_id: `source-${j.source_id}`,
        summary: { outcome: j.outcome === 'success' ? 'success' : 'failed', duration_ms: Math.max(0, j.finished_at - j.started_at) * 1000, total_resources: j.received, ...(j.error ? { error_message: j.error } : {}) },
      })),
    };
  };

  /** Go's LegalConsentStatus, from the stored timestamp ('' = not accepted). */
  const consentStatus = (acceptedAt: string): Record<string, unknown> => ({
    accepted: acceptedAt !== '',
    ...(acceptedAt !== '' ? { accepted_at: acceptedAt } : {}),
    privacy_policy_url: '/privacy',
    terms_of_service_url: '/terms',
  });

  /** The caller's source, by its public id — undefined for another user's or a malformed id. */
  const owned = (username: string, publicId: string): ConnectedSource | undefined => {
    const m = publicId.match(/^source-(\d+)$/);
    if (!m) return undefined;
    const s = sources.byId(Number(m[1]));
    return s && s.userId === username ? s : undefined;
  };

  // Until Sources is a manager, the Records manager asks the app for a source's display name.
  records.sourceDisplay = (sourceId: string): string => {
    const numeric = Number(sourceId.replace('source-', ''));
    return sources.list().find((s) => s.id === numeric)?.display ?? '';
  };

  const server = createYourPhrServer({
    engine,
    auth: { cookieMaxAgeSeconds: config.getInt('auth.session.absolute-seconds'), secureCookies: config.getBool('web.secure-cookies') },
    webDir: options.webDir,
    version: options.version,
    modules: {
      // Only what an anonymous caller may know; the password minimum is published so the UI can say
      // it before the server refuses (yourphr#506's shape).
      publicInstance: publicInstanceKeys,
      instanceForUser: () => ({
        ...publicInstanceKeys(),
        'operator.contact_email': config.getString('operator.contact_email'), // signed-in only (yourphr#459)
        'demo.admin.session': false, // this stack has no demo admin; the UI reads strictly true
      }),
      jobsForUser: (username, query) => {
        // Go's filters, honestly mapped: SYNC is the only job type here; STATUS_DONE/STATUS_FAILED are
        // the only statuses a recorded job can have, so READY/LOCKED match nothing rather than something.
        if (query.jobType && query.jobType !== 'SYNC') return [];
        let outcome: 'success' | 'failure' | undefined;
        if (query.status === 'STATUS_DONE') outcome = 'success';
        else if (query.status === 'STATUS_FAILED') outcome = 'failure';
        else if (query.status) return [];
        return sources.jobsForUser(username, { limit: query.limit, offset: query.page * query.limit, outcome }).map((job) => backgroundJobShape(job, username));
      },
      sources: {
        list: (username) => sources.list().filter((s) => s.userId === username).map((s) => sourceShape(s, sources.latestJob(s.id))),
        get: (username, id) => {
          const s = owned(username, id);
          return s ? sourceShape(s, sources.latestJob(s.id)) : undefined;
        },
        summary: async (ctx, id) => {
          const s = owned(ctx.username, id);
          if (!s) return undefined;
          return {
            source: sourceShape(s, sources.latestJob(s.id)),
            resource_type_counts: await records.sourceCounts(ctx, id),
            patient: await records.patientOf(ctx, id),
          };
        },
        sync: async (username, id) => {
          const s = owned(username, id);
          if (!s) return undefined;
          events.publish(username, { event_type: 'source_sync', source_id: id });
          const job = await syncSource(workerDeps, s);
          events.publish(username, { event_type: 'source_complete', source_id: id });
          if (job.outcome !== 'success') throw new Error(job.error || 'sync failed');
          // Go answers with its upsert summary; the page prints data as "N row(s) effected".
          return { source: sourceShape(sources.byId(s.id) ?? s, job), data: job.created + job.updated };
        },
        disconnect: (username, id) => {
          const s = owned(username, id);
          if (!s) return false;
          sources.clearTokens(s.id);
          return true;
        },
        removeData: async (ctx, id) => (owned(ctx.username, id) ? records.removeSource(ctx, id) : undefined),
        remove: async (ctx, id) => {
          const s = owned(ctx.username, id);
          if (!s) return undefined;
          const rows = await records.removeSource(ctx, id);
          sources.remove(s.id);
          return rows;
        },
        exportBundle: async (ctx, id) => {
          const s = owned(ctx.username, id);
          if (!s) return undefined;
          const bundle = await records.exportSource(ctx, id);
          const slug = s.display.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          return { filename: `yourphr-${slug}-${stamp}.json`, bundle };
        },
        // The catalog's connectable entries in Go's ConnectableProvider shape, policy resolved by
        // Go's rules (yourphr#603).
        connectable: () => catalog.connectable().map(connectableShape),
        events,
      },
      ips: (ctx) => records.ips(ctx).then((d) => d.bundle),
      provenanceFor: (ctx, resourceType, id) => records.provenance(ctx, resourceType, id),
      medications: (ctx) => records.medications(ctx),
      catalog: {
        list: () => catalog.list().map(catalogEntryShape),
        get: (id) => {
          const e = catalogById(id);
          return e ? catalogEntryShape(e) : undefined;
        },
        create: (body) => {
          const write = catalogWriteFrom(body);
          if (!write.display || !write.fhirBaseUrl || !write.clientId) throw withStatus(400, 'display, api_endpoint_base_url, and client_id are required');
          try {
            return catalogEntryShape(catalog.create(write));
          } catch (err) {
            throw withStatus(400, (err as Error).message);
          }
        },
        update: (id, body) => {
          const e = catalogById(id);
          if (!e) return undefined;
          const write = catalogWriteFrom(body, e);
          try {
            return catalogEntryShape(catalog.update(e.id, write));
          } catch (err) {
            throw withStatus(400, (err as Error).message);
          }
        },
        remove: (id) => {
          const e = catalogById(id);
          return e ? catalog.remove(e.id) : false;
        },
        // Sandboxes are for the admin to try a provider before a member meets it (the Sandbox page).
        sandbox: () => catalog.list().filter((e) => e.enabled && e.environment === 'sandbox').map(connectableShape),
        authorize: async (_username, id, body) => {
          const e = enabledCatalogEntry(id);
          const redirectUri = typeof body['redirect_uri'] === 'string' ? (body['redirect_uri'] as string).trim() : '';
          if (redirectUri === '') {
            // Go derives the callback from its SMART relay; there is no relay in this stack (the product's #408).
            throw withStatus(501, 'no SMART relay in this stack — supply redirect_uri (this deployment\'s /sources/callback/<state> page)');
          }
          const client = smartClientFor(e, redirectUri);
          let endpoints;
          try {
            endpoints = await client.discover();
          } catch (err) {
            throw withStatus(502, `SMART discovery failed: ${(err as Error).message}`);
          }
          if (e.authorizeUrlOverride !== '') endpoints = { ...endpoints, authorization: e.authorizeUrlOverride };
          const state = randomUUID();
          const verifier = generateVerifier();
          return { authorize_url: client.authorizeUrl(endpoints, state, verifier), state, code_verifier: verifier, redirect_uri: redirectUri };
        },
        connect: async (ctx, id, body) => {
          const username = ctx.username;
          const e = enabledCatalogEntry(id);
          if (connectionPolicy(e).requiresUserConsent && users.consentAcceptedAt(ctx) === '') {
            throw Object.assign(withStatus(403, 'Accept the Privacy Policy and Terms of Service on Account Profile before connecting a medical source.'),
              { extra: { error_code: 'legal_consent_required', privacy_policy_url: '/privacy', terms_of_service_url: '/terms' } });
          }
          const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
          const verifier = str('code_verifier');
          const code = str('code');
          if (verifier === '') throw withStatus(400, 'code_verifier is required');
          if (code === '' && str('state') === '') throw withStatus(400, 'one of code or state is required');
          if (code === '') throw withStatus(501, 'no SMART relay in this stack — the callback page must send the authorization code');
          const redirectUri = str('redirect_uri');
          if (redirectUri === '') throw withStatus(400, 'redirect_uri is required (the one the authorization used)');
          const client = smartClientFor(e, redirectUri);
          let endpoints;
          try {
            endpoints = await client.discover();
          } catch (err) {
            throw withStatus(502, `SMART discovery failed: ${(err as Error).message}`);
          }
          let token;
          try {
            token = await client.exchangeCode(endpoints, code, verifier);
          } catch (err) {
            throw withStatus(502, `token exchange failed: ${(err as Error).message}`);
          }
          const patient = (token.patient ?? '').trim();
          if (patient === '') throw withStatus(502, 'token had no patient id — this stack does not yet resolve one from the FHIR API');
          const patientFacing = connectableShape(e)['display'] as string;
          const display = patientFacing === e.display && str('display') !== '' ? str('display') : patientFacing;
          const source = sources.add({
            userId: username, display, fhirBaseUrl: e.fhirBaseUrl, tokenUrl: endpoints.token, clientId: e.clientId, patient,
            resourceTypes: resourceTypesFromScopes(e.scopes), accessToken: token.accessToken, refreshToken: token.refreshToken ?? '',
            expiresAt: token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : 0,
            platformType: e.platformType || 'ehr', environment: e.environment,
          });
          // The initial import runs in the background, as Go's does; the page follows it on the event stream.
          void (async () => {
            events.publish(username, { event_type: 'source_sync', source_id: `source-${source.id}` });
            try {
              await syncSource(workerDeps, source);
            } catch (err) {
              appLog.error(`initial sync failed for source ${source.id}: ${(err as Error).message}`);
            }
            events.publish(username, { event_type: 'source_complete', source_id: `source-${source.id}` });
          })();
          return { source: sourceShape(source, undefined), data: { status: 'import_started' } };
        },
      },
      records: {
        recent: (ctx, limit) => records.recent(ctx, limit),
        conditions: (ctx) => records.conditions(ctx),
        allergies: (ctx) => records.allergies(ctx),
        immunizations: (ctx) => records.immunizations(ctx),
        query: (ctx, body) => records.query(ctx, body as unknown as Parameters<RecordsManager['query']>[1]),
      },
      account: {
        legalDocument: (kind) => {
          const parsed = parseLegalKind(kind);
          return parsed ? loadLegalDocument(dataDir, parsed) : undefined;
        },
        accessLog: (username) => account.listAccess(username),
        recordAccess: (username, pathname) => {
          const category = accessCategoryFor(pathname);
          if (category) account.recordAccess(username, username, category);
        },
        legalConsent: (ctx) => consentStatus(users.consentAcceptedAt(ctx)),
        grantConsent: (ctx) => {
          const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
          users.setConsent(ctx, now);
          return consentStatus(now);
        },
        revokeConsent: (ctx) => {
          users.setConsent(ctx, '');
          // Go's rule: revoking the consent disconnects the sources that required it.
          let disconnected = 0;
          for (const s of sources.list()) {
            if (s.userId !== ctx.username || !providerRequiresLegalConsent(s.display, s.fhirBaseUrl, s.platformType)) continue;
            sources.clearTokens(s.id);
            disconnected++;
          }
          return { ...consentStatus(''), medicare_sources_disconnected: disconnected };
        },
        changePassword: async (ctx, current, next) => {
          await users.changePassword(ctx, current, next); // 401 wrong current, 400 policy — as ApiError
          return sessions.issueFor(ctx.username);
        },
        signOutEverywhere: (ctx) => sessions.revokeAll(ctx),
        deleteAccount: async (ctx) => {
          // Everything the account owns, then the account: its sources, every record (the Records
          // manager removes rows, index and history and drops the handle), favourites, the access
          // log, then the account itself (consent goes with it).
          const username = ctx.username;
          for (const s of sources.list().filter((s) => s.userId === username)) sources.remove(s.id);
          await records.removeAll(ctx);
          for (const fav of favorites.list(username, 'Practitioner')) favorites.remove(username, fav);
          account.deleteUser(username);
          await users.deleteSelf(ctx);
        },
      },
      favorites: {
        list: (username, resourceType) => favorites.list(username, resourceType),
        add: (username, fav) => favorites.add(username, fav),
        remove: (username, fav) => favorites.remove(username, fav),
        supports: (resourceType) => FavoriteStore.supports(resourceType),
      },
      admin: {
        configSnapshot: () => ({
          entries: config.snapshot().map((row) => {
            const spec = config.specOf(row.key)!;
            const masked = row.value === '••••';
            return {
              key: row.key,
              value: row.value,
              masked,
              source: row.source === 'custom' ? 'custom' : 'default',
              public: PUBLIC_KEYS.has(row.key),
              promoted: false,
              default: spec.secret && String(spec.default) !== '' ? '••••' : spec.default,
              from_env: row.source === 'environment',
              env_var: envNameFor(row.key),
              description: row.description,
              bootstrap: spec.bootstrap === true,
            };
          }),
          custom_config_path: config.customConfigPath(),
          warnings: [],
        }),
        configReveal: (key) => {
          const spec = config.specOf(key);
          if (!spec) return undefined;
          appLog.info(`admin revealed configuration value for ${key}`);
          return { key, value: config.reveal(key), default: spec.default };
        },
        configSet: (key, value) => {
          const spec = config.specOf(key);
          if (!spec) throw withStatus(400, `unknown configuration key ${JSON.stringify(key)} — only keys this stack describes can be set`);
          if (config.isSetByEnvironment(key)) throw withStatus(409, `${key} is set by the environment variable ${envNameFor(key)}, which takes precedence over this screen — change it in your deployment configuration instead`);
          let coerced: ConfigValue;
          try {
            coerced = coerceToShippedType(value, spec.default);
          } catch (err) {
            throw withStatus(400, `${key}: ${(err as Error).message}`);
          }
          try {
            config.set(key, coerced);
          } catch (err) {
            throw withStatus(400, (err as Error).message);
          }
          appLog.info(`admin set configuration ${key}`);
        },
        configReset: (key) => {
          const spec = config.specOf(key);
          if (!spec) throw withStatus(400, `unknown configuration key ${JSON.stringify(key)}`);
          return config.clear(key);
        },
        catalogList: () => catalog.list(),
        backupNow,
        createUser: (ctx, username, password, role) => users.createUser(ctx, username, password, role === 'admin' ? 'admin' : 'user'),
        listUsers: async (ctx) => (await users.listUsers(ctx)).map((u) => ({ id: u.username, username: u.username, role: u.role, created_at: u.created_at, login_count: 0 })),
        resetUserPassword: async (ctx, username) => {
          const password = await users.adminResetPassword(ctx, username);
          appLog.info(`admin reset the password for ${username}; every session of that account ended`);
          return { username, password };
        },
        instanceSettings: () => ({ name: config.getString('operator.name'), contact_email: config.getString('operator.contact_email'), contact_url: config.getString('operator.contact_url') }),
        setInstanceSettings: (s) => {
          config.set('operator.name', s.name);
          config.set('operator.contact_email', s.contact_email);
          config.set('operator.contact_url', s.contact_url);
        },
        metrics: () => adminMetrics(),
        databaseInfo: () => adminOps.databaseInfo(),
        backupFile: async () => {
          const r = await adminOps.backupNow();
          return { file: r.file, name: basename(r.file), sizeBytes: r.sizeBytes };
        },
        setSchedule: (body) => adminOps.setSchedule(body as never),
        testDestination: (destination) => adminOps.testDestination(destination),
        browse: (path) => adminOps.browse(path),
        stageRestore: (name) => adminOps.stageRestore(name),
        logs: () => ({ level: appLog.currentLevel(), valid_levels: VALID_LEVELS, lines: appLog.recent() }),
        setLogLevel: (level) => {
          const set = appLog.setLevel(level);
          appLog.info(`admin changed server log level to ${JSON.stringify(set)}`);
          return set;
        },
        // No SMART relay in this stack (the product's #408 is not ported): honestly not configured.
        relayConfig: () => ({ callback_url: '', configured: false, ready: false, public_url: '', poll_url: '', secret: '' }),
      },
    },
  });

  return {
    server,
    engine,
    config,
    users,
    sessions,
    catalog,
    sources,
    account,
    bootstrapPasswordFile: bootstrap.passwordFile,
    syncNow: (now?: number) => runSyncPass(workerDeps, now),
    backupNow,
    close: async () => {
      if (timer) clearInterval(timer);
      if (scheduleTimer) clearInterval(scheduleTimer);
      server.close();
      await stores.close();
    },
  };
}

/** Go's coerceToShippedType: the stored value keeps the type of the shipped default. */
export function coerceToShippedType(value: unknown, shipped: ConfigValue): ConfigValue {
  if (typeof shipped === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new Error('expected true or false');
  }
  if (typeof shipped === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || value === '' || !Number.isFinite(n)) throw new Error('expected a number');
    return n;
  }
  if (Array.isArray(shipped)) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
    throw new Error('expected a list');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('expected text');
}
