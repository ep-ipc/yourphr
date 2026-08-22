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
import { ConfigStore } from './config/index.js';
import { addColumnWithDefault, runMigrations, type Migration } from './migrations/index.js';
import { AuthStore } from './auth/index.js';
import { ProviderCatalog, type CatalogWrite } from './catalog/index.js';
import { SourceStore, runSyncPass, syncSource, type ConnectedSource, type JobSummary } from './worker/index.js';
import { EventBus } from './events/index.js';
import { reconcileConditions, type InputResource } from './conditions/index.js';
import { classifyAllergies } from './allergies/index.js';
import { classifyImmunizations } from './immunizations/index.js';
import { recentResources, runQuery, type QueryRequest } from './query/index.js';
import { FavoriteStore } from './favorites/index.js';
import { backupDatabase } from './backup/index.js';
import { buildIps } from './ips/index.js';
import { provenanceFor } from './provenance/index.js';
import { reconcile, type MedInput } from './medication/index.js';
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
];

/** Everything that owns data, opened the one way the server opens it. */
export interface Stores {
  config: ConfigStore;
  db: InstanceType<typeof Database>;
  /** '' when the database is unencrypted. */
  dbKey: string;
  auth: AuthStore;
  catalog: ProviderCatalog;
  sources: SourceStore;
  favorites: FavoriteStore;
  repoForUser: (userId: string) => SqliteFhirRepository;
  repos: Map<string, SqliteFhirRepository>;
  close: () => void;
}

export function openStores(dataDir: string, env: Record<string, string | undefined> = process.env): Stores {
  // 1. Config — everything below reads it.
  const config = new ConfigStore(dataDir, undefined, env);
  const unknown = config.unknownKeys();
  if (unknown.length > 0) {
    console.warn(`config: keys with no effect: ${unknown.join(', ')}`); // yourphr#473 — reported, not dropped
  }

  // 2. The app database + migrations before anything opens for business.
  const dbKey = config.getString('database.encryption.key');
  const db = new Database(join(dataDir, config.getString('database.location')));
  if (dbKey !== '') {
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key='${dbKey.replace(/'/g, "''")}'`);
  }
  runMigrations(db, APP_MIGRATIONS);

  // 3. Auth, policies from configuration.
  const auth = new AuthStore(db, {
    sessionKey: randomBytes(32),
    session: { slidingSeconds: config.getInt('auth.session.sliding-seconds'), absoluteSeconds: config.getInt('auth.session.absolute-seconds') },
    throttle: { maxFailures: config.getInt('auth.throttle.max-failures'), windowSeconds: config.getInt('auth.throttle.window-seconds') },
    minPasswordLength: config.getInt('auth.password.min-length'),
    trustedProxies: config.getStringList('auth.trusted-proxies'),
  });

  // 4. Catalog and 5. sources + per-user repositories — the same seam the HTTP layer and worker share.
  const catalog = new ProviderCatalog(db);
  const sources = new SourceStore(db);
  const favorites = new FavoriteStore(db);
  const recordsPath = join(dataDir, 'records.db');
  const repos = new Map<string, SqliteFhirRepository>();
  const repoForUser = (userId: string): SqliteFhirRepository => {
    let repo = repos.get(userId);
    if (!repo) {
      repo = new SqliteFhirRepository({ file: recordsPath, userId, key: dbKey === '' ? undefined : dbKey });
      repos.set(userId, repo);
    }
    return repo;
  };

  return {
    config, db, dbKey, auth, catalog, sources, favorites, repoForUser, repos,
    close: () => {
      for (const repo of repos.values()) repo.db.close();
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
  config: ConfigStore;
  auth: AuthStore;
  catalog: ProviderCatalog;
  sources: SourceStore;
  bootstrapPasswordFile?: string;
  syncNow: (now?: number) => Promise<unknown>;
  backupNow: () => unknown;
  close: () => void;
}

export function assembleApp(dataDir: string, options: { seeds?: CatalogWrite[]; env?: Record<string, string | undefined>; workerIntervalMs?: number; webDir?: string; version?: string } = {}): App {
  const stores = openStores(dataDir, options.env ?? process.env);
  const { config, auth, catalog, sources, favorites, repoForUser } = stores;

  // Bootstrap the first admin on an empty install — after auth exists, before anything serves.
  const bootstrap = auth.bootstrapAdmin(dataDir);

  // Provision-then-preserve.
  if (options.seeds) {
    catalog.seed(options.seeds);
  }

  const workerDeps = { store: sources, repoForUser, maxPages: config.getInt('sync.max-pages'), allowInternal: (options.env ?? process.env)['SPIKE_TEST_ALLOW_INTERNAL'] === '1' };
  const timer = options.workerIntervalMs
    ? setInterval(() => { void runSyncPass(workerDeps); }, options.workerIntervalMs)
    : undefined;
  timer?.unref?.();

  const backupNow = () => {
    const destination = config.getString('backup.destination') || join(dataDir, 'backups');
    return backupDatabase(repoForUser('__any__'), {
      destination,
      backupKey: config.getString('backup.encryption.key'), // '' refuses — backups are always encrypted
      maxBackups: config.getInt('backup.max-backups'),
    });
  };

  const medications = async (repo: SqliteFhirRepository) => {
    const inputs: MedInput[] = [];
    for (const type of ['MedicationRequest', 'MedicationStatement', 'MedicationDispense'] as const) {
      const bundle = await repo.search({ resourceType: type, count: 1000, total: 'accurate' });
      for (const entry of bundle.entry ?? []) {
        const row = repo.db
          .prepare('SELECT source_id FROM resources WHERE resource_type = ? AND id = ? AND user_id = ?')
          .get(type, (entry.resource as { id?: string }).id, repo.userId ?? '') as { source_id: string } | undefined;
        inputs.push({ resource: entry.resource as never, sourceId: row?.source_id ?? '' });
      }
    }
    return reconcile(inputs);
  };

  /** Every live record of one type for the repository's user, as the classifiers take them. */
  const inputsOf = (repo: SqliteFhirRepository, resourceType: string): InputResource[] =>
    (repo.db
      .prepare('SELECT id, source_id, content FROM resources WHERE resource_type = ? AND user_id = ? AND deleted = 0 ORDER BY id')
      .all(resourceType, repo.userId ?? '') as { id: string; source_id: string; content: string }[])
      .map((r) => ({ sourceResourceType: resourceType, sourceResourceId: r.id, sourceId: r.source_id, raw: JSON.parse(r.content) as unknown }));

  // The instance keys Go publishes that this stack has a value for. A key this stack does not have
  // (theme, demo, signup, the wider password policy) is ABSENT, and the Angular app's mapper already
  // defaults an absent key — nothing is invented to fill Go's list.
  const publicInstanceKeys = (): Record<string, unknown> => ({
    'operator.name': config.getString('operator.name'),
    'operator.contact_url': config.getString('operator.contact_url'),
    'password.min_length': config.getInt('auth.password.min-length'),
  });

  const events = new EventBus();

  /** The caller's source, by its public id — undefined for another user's or a malformed id. */
  const owned = (username: string, publicId: string): ConnectedSource | undefined => {
    const m = publicId.match(/^source-(\d+)$/);
    if (!m) return undefined;
    const s = sources.byId(Number(m[1]));
    return s && s.userId === username ? s : undefined;
  };

  /** Removes every record a source wrote for this user: rows, their index, their history. Returns the row count. */
  const removeSourceRecords = (repo: SqliteFhirRepository, username: string, publicId: string): number => {
    const remove = repo.db.transaction((): number => {
      const rows = repo.db.prepare('SELECT resource_type, id FROM resources WHERE user_id = ? AND source_id = ?').all(username, publicId) as { resource_type: string; id: string }[];
      const delIndex = repo.db.prepare('DELETE FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ?');
      const delHistory = repo.db.prepare('DELETE FROM resource_history WHERE resource_type = ? AND id = ?');
      for (const r of rows) {
        delIndex.run(r.resource_type, r.id, username);
        delHistory.run(r.resource_type, r.id);
      }
      return repo.db.prepare('DELETE FROM resources WHERE user_id = ? AND source_id = ?').run(username, publicId).changes;
    });
    return remove();
  };

  const sourceDisplay = (sourceId: string): string => {
    const numeric = Number(sourceId.replace('source-', ''));
    return sources.list().find((s) => s.id === numeric)?.display ?? '';
  };

  const server = createYourPhrServer({
    repo: repoForUser('__unused__'), // never serves: auth is wired, every request resolves its own repo
    auth: { store: auth, repoForUser, cookieMaxAgeSeconds: config.getInt('auth.session.absolute-seconds'), secureCookies: config.getBool('web.secure-cookies') },
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
        summary: (username, id, repo) => {
          const s = owned(username, id);
          if (!s) return undefined;
          const counts = (repo.db
            .prepare('SELECT resource_type, COUNT(*) AS count FROM resources WHERE user_id = ? AND source_id = ? AND deleted = 0 GROUP BY resource_type ORDER BY resource_type')
            .all(username, id) as { resource_type: string; count: number }[])
            .map((r) => ({ source_id: id, resource_type: r.resource_type, count: r.count }));
          const patientRow = repo.db
            .prepare("SELECT content FROM resources WHERE user_id = ? AND source_id = ? AND resource_type = 'Patient' AND deleted = 0 ORDER BY last_updated DESC LIMIT 1")
            .get(username, id) as { content: string } | undefined;
          return {
            source: sourceShape(s, sources.latestJob(s.id)),
            resource_type_counts: counts,
            patient: patientRow ? toResourceFhir(JSON.parse(patientRow.content), id) : null,
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
        removeData: (username, id, repo) => (owned(username, id) ? removeSourceRecords(repo, username, id) : undefined),
        remove: (username, id, repo) => {
          const s = owned(username, id);
          if (!s) return undefined;
          const rows = removeSourceRecords(repo, username, id);
          sources.remove(s.id);
          return rows;
        },
        exportBundle: (username, id, repo) => {
          const s = owned(username, id);
          if (!s) return undefined;
          const rows = repo.db
            .prepare('SELECT content FROM resources WHERE user_id = ? AND source_id = ? AND deleted = 0 ORDER BY resource_type, id')
            .all(username, id) as { content: string }[];
          const entry = rows.map((r) => ({ resource: JSON.parse(r.content) as unknown }));
          const slug = s.display.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          return { filename: `yourphr-${slug}-${stamp}.json`, bundle: { resourceType: 'Bundle', type: 'collection', total: entry.length, entry } };
        },
        // The catalog's connectable entries in Go's ConnectableProvider shape. The consent and
        // pre-connect fields are not carried (yourphr#586) and read as "none" here; the connect
        // flow itself is yourphr#603's.
        connectable: () => catalog.connectable().map((e) => ({
          id: String(e.id), display: e.display, brand_logo_url: '', requires_user_consent: false,
          pre_connect_profile: '', medicare_class: false, requires_legal_consent: false,
        })),
        events,
      },
      ips: (repo) => buildIps(repo, new Date()).then((d) => d.bundle),
      provenanceFor: (repo, resourceType, id) =>
        provenanceFor({ db: repo.db, userId: repo.userId ?? '', sourceDisplay }, resourceType, id),
      medications,
      records: {
        recent: (repo, limit) => recentResources(repo, limit),
        conditions: (repo) => reconcileConditions(inputsOf(repo, 'Condition')),
        allergies: (repo) => classifyAllergies(inputsOf(repo, 'AllergyIntolerance')),
        immunizations: (repo) => classifyImmunizations(inputsOf(repo, 'Immunization')),
        query: (repo, body) => runQuery(repo, body as unknown as QueryRequest),
      },
      favorites: {
        list: (username, resourceType) => favorites.list(username, resourceType),
        add: (username, fav) => favorites.add(username, fav),
        remove: (username, fav) => favorites.remove(username, fav),
        supports: (resourceType) => FavoriteStore.supports(resourceType),
      },
      admin: {
        isAdmin: (username) => auth.isAdmin(username),
        configSnapshot: () => config.snapshot(),
        catalogList: () => catalog.list(),
        backupNow,
        createUser: (username, password) => auth.createUser(username, password),
      },
    },
  });

  return {
    server,
    config,
    auth,
    catalog,
    sources,
    bootstrapPasswordFile: bootstrap.passwordFile,
    syncNow: (now?: number) => runSyncPass(workerDeps, now),
    backupNow,
    close: () => {
      if (timer) clearInterval(timer);
      server.close();
      stores.close();
    },
  };
}
