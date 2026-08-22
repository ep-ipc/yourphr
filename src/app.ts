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
import { CatalogManager, type CatalogWrite } from './app/managers/CatalogManager.js';
import { SqliteCatalogProvider } from './app/providers/SqliteCatalogProvider.js';
import { Engine } from './framework/Engine.js';
import { ConfigurationManager } from './framework/ConfigurationManager.js';
import { ApiContext } from './framework/ApiContext.js';
import { RecordsManager } from './app/managers/RecordsManager.js';
import { SqliteRecordsProvider } from './app/providers/SqliteRecordsProvider.js';
import { SourcesManager, sourceShape } from './app/managers/SourcesManager.js';
import { JobsManager, backgroundJobShape } from './framework/managers/JobsManager.js';
import { SqliteSourcesProvider } from './app/providers/SqliteSourcesProvider.js';
import { SqliteJobsProvider } from './framework/providers/SqliteJobsProvider.js';
import { NullSourceClientProvider, type BaseSourceClientProvider } from './app/providers/BaseSourceClientProvider.js';
export { sourceShape, backgroundJobShape };
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
  /** The one door to the provider catalog (yourphr#613). */
  catalog: CatalogManager;
  /** The one door to connected sources and their sync (yourphr#612). */
  sources: SourcesManager;
  /** The one door to the job history (yourphr#612). */
  jobs: JobsManager;
  /** The per-member event stream the Sources page follows. */
  events: EventBus;
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

/** The source-client provider configuration names: 'smart' loads the SMART client; 'null' loads nothing; anything else refuses to boot. */
async function sourceClientFor(name: string, env: Record<string, string | undefined>): Promise<BaseSourceClientProvider> {
  if (name === 'null') return new NullSourceClientProvider();
  if (name === 'smart') {
    const { SmartSourceClientProvider } = await import('./app/providers/SmartSourceClientProvider.js');
    return new SmartSourceClientProvider({ allowInternal: env['SPIKE_TEST_ALLOW_INTERNAL'] === '1' });
  }
  throw new Error(`sources.client.provider: unknown provider '${name}' (smart or null)`);
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
  // 7. Jobs and Sources (yourphr#612): the source client is an OPTIONAL capability — bound by
  // configuration, loaded only when configured, inert (and said so) when not.
  const events = new EventBus();
  engine.register('jobs', new JobsManager(engine, new SqliteJobsProvider(db)));
  const sourceClient = await sourceClientFor(config.getString('sources.client.provider'), env);
  const allowInternal = env['SPIKE_TEST_ALLOW_INTERNAL'] === '1';
  engine.register('sources', new SourcesManager(engine, new SqliteSourcesProvider(db), sourceClient, {
    maxPages: config.getInt('sync.max-pages'),
    events,
    log: (line) => appLog.info(line),
  }));
  // 8. Catalog (yourphr#613): what the instance can connect to; connects through Sources and the same client.
  engine.register('catalog', new CatalogManager(engine, new SqliteCatalogProvider(db), sourceClient, { allowInternal, log: (line) => appLog.warn(line) }));
  await engine.initialize();
  appLog.info(`engine: ${engine.registered.join(' -> ')}`);
  const { records, sources, jobs, catalog } = engine.managers;
  // The Records manager names a source for the records that carry its id — asked of the Sources door.
  records.sourceDisplay = (sourceId) => sources.displayOf(sourceId);

  return {
    config, db, dbKey, users, sessions, catalog, sources, jobs, events, favorites, account, engine, records, recordsProvider,
    close: async () => {
      await engine.shutdown();
      db.close();
    },
  };
}

export interface App {
  server: ReturnType<typeof createYourPhrServer>;
  engine: Engine;
  config: ConfigStore;
  users: UsersManager;
  sessions: SessionsManager;
  catalog: CatalogManager;
  sources: SourcesManager;
  jobs: JobsManager;
  account: AccountStore;
  bootstrapPasswordFile?: string;
  syncNow: (now?: number) => Promise<unknown>;
  backupNow: () => Promise<unknown>;
  close: () => Promise<void>;
}

export async function assembleApp(dataDir: string, options: { seeds?: CatalogWrite[]; env?: Record<string, string | undefined>; workerIntervalMs?: number; webDir?: string; version?: string } = {}): Promise<App> {
  const stores = await openStores(dataDir, options.env ?? process.env);
  const { config, users, sessions, catalog, sources, favorites, account, engine, records, events } = stores;
  /** The worker and the migration tool act for an account as a named system principal. */
  const systemCtx = (name: string, username: string): ApiContext => ApiContext.system(name, username, engine);

  // Bootstrap the first admin on an empty install — after the managers exist, before anything serves.
  const bootstrap = await users.bootstrapAdmin(dataDir);

  // Provision-then-preserve.
  if (options.seeds) {
    await catalog.seed(options.seeds);
  }

  // The worker: the Sources manager's pass, on the configured interval.
  const timer = options.workerIntervalMs
    ? setInterval(() => { void sources.pass(); }, options.workerIntervalMs)
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

  /** The keys /api/instance/public publishes — Go's `public` list, as far as this stack has values. */
  const PUBLIC_KEYS = new Set(['operator.name', 'operator.contact_url', 'auth.password.min-length']);

  const withStatus = (status: number, message: string): Error & { status: number } => Object.assign(new Error(message), { status });

  /** Go's LegalConsentStatus, from the stored timestamp ('' = not accepted). */
  const consentStatus = (acceptedAt: string): Record<string, unknown> => ({
    accepted: acceptedAt !== '',
    ...(acceptedAt !== '' ? { accepted_at: acceptedAt } : {}),
    privacy_policy_url: '/privacy',
    terms_of_service_url: '/terms',
  });

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
      ips: (ctx) => records.ips(ctx).then((d) => d.bundle),
      provenanceFor: (ctx, resourceType, id) => records.provenance(ctx, resourceType, id),
      medications: (ctx) => records.medications(ctx),
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
        revokeConsent: async (ctx) => {
          users.setConsent(ctx, '');
          // Go's rule: revoking the consent disconnects the sources that required it.
          const disconnected = await sources.disconnectWhere(ctx, (s) => providerRequiresLegalConsent(s.display, s.fhirBaseUrl, s.platformType));
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
          await sources.removeAll(ctx);
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
        metrics: (ctx) => sources.adminMetrics(ctx),
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
    jobs: stores.jobs,
    account,
    bootstrapPasswordFile: bootstrap.passwordFile,
    syncNow: (now?: number) => sources.pass(now),
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
