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
import { FileConfigProvider } from './framework/providers/FileConfigProvider.js';
import { addColumnWithDefault, type Migration } from './framework/providers/sqlite-migrations.js';
import { DatabaseManager } from './framework/managers/DatabaseManager.js';
import { SqliteDatabaseProvider } from './framework/providers/SqliteDatabaseProvider.js';
import { UsersManager } from './framework/managers/UsersManager.js';
import { SessionsManager } from './framework/managers/SessionsManager.js';
import { SqliteUsersProvider } from './framework/providers/SqliteUsersProvider.js';
import { PasswordAuthProvider } from './framework/providers/PasswordAuthProvider.js';
import { CatalogManager, type CatalogWrite } from './app/managers/CatalogManager.js';
import { SqliteCatalogProvider } from './app/providers/SqliteCatalogProvider.js';
import { Engine } from './framework/Engine.js';
import { ConfigurationManager } from './framework/ConfigurationManager.js';
import { SettingsManager, coerceToShippedType } from './framework/managers/SettingsManager.js';
export { coerceToShippedType };
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
import { SqliteFavoritesProvider } from './app/providers/SqliteFavoritesProvider.js';
import { AuditManager } from './framework/managers/AuditManager.js';
import { SqliteAuditProvider } from './framework/providers/SqliteAuditProvider.js';
import { BackupManager, applyStagedRestore } from './framework/managers/BackupManager.js';
import { FilesystemBackupProvider } from './framework/providers/FilesystemBackupProvider.js';
import { NullBackupProvider, type BaseBackupProvider } from './framework/providers/BaseBackupProvider.js';
import { BACKUP_SUFFIX, STAGED_APP, STAGED_RECORDS } from './app/providers/sqlite-backup.js';
import { appLog, VALID_LEVELS } from './log/index.js';
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
  config: ConfigurationManager;
  /** The app database's handle — the composition root's and the harnesses'; never a route's. */
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
  /** The access log (yourphr#614) — required; refuses to boot unhealthy. */
  audit: AuditManager;
  /** Backups (yourphr#615): schedule, health, staged restore over optional storage. */
  backups: BackupManager;
  /** The composition root (yourphr#608): managers, in validated boot order. */
  engine: Engine;
  /** The one door to records (yourphr#609). */
  records: RecordsManager;
  /** The PHI-storage provider — for the migration tool's verification gate, which reads below the manager on purpose. */
  recordsProvider: SqliteRecordsProvider;
  close: () => Promise<void>;
}

/** The backup-storage provider configuration names: 'filesystem' or 'null' (inert, said so); anything else refuses to boot. */
function backupProviderFor(name: string): BaseBackupProvider {
  if (name === 'filesystem') return new FilesystemBackupProvider(BACKUP_SUFFIX);
  if (name === 'null') { appLog.warn('backup.storage.provider = null: no backup storage — every backup action will refuse'); return new NullBackupProvider(); }
  throw new Error(`backup.storage.provider: unknown provider '${name}' (filesystem or null)`);
}

/** The audit provider configuration names: only 'sqlite' exists; anything else is a refusal, never a silent Null. */
function auditProviderFor(name: string, db: InstanceType<typeof Database>): SqliteAuditProvider {
  if (name === 'sqlite') return new SqliteAuditProvider(db);
  throw new Error(`audit.provider: unknown provider '${name}' (sqlite) — refusing to boot with auditing off`);
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
  // 1. Config — everything below reads it, so the engine and its first manager come first.
  // The configuration capability is the BOOTSTRAP LAYER (yourphr#621): the one capability NOT
  // selected by configuration, because it is what reads configuration. The composition root picks
  // its provider here, alongside the data directory and the database key.
  const engine = new Engine();
  const config = new ConfigurationManager(engine, new FileConfigProvider(dataDir), { env, log: (line) => appLog.info(line) });
  engine.register('configuration', config);
  const unknown = config.unknownKeys();
  if (unknown.length > 0) {
    appLog.warn(`config: keys with no effect: ${unknown.join(', ')}`); // yourphr#473 — reported, not dropped
  }

  // 2. The app database + migrations before anything opens for business.
  const dbKey = config.getString('database.encryption.key');
  const engineRef = (): Engine => engine;
  applyStagedRestore(dataDir, [[STAGED_RECORDS, 'records.db'], [STAGED_APP, config.getString('database.location')]], (line) => appLog.info(line)); // yourphr#602: a staged restore lands before anything opens
  // The app database's one connection is the engine's (yourphr#617): opened and migrated by its
  // provider before any sibling provider is built over it; closed last at shutdown.
  const database = new DatabaseManager(engine, new SqliteDatabaseProvider(join(dataDir, config.getString('database.location')), dbKey, APP_MIGRATIONS));
  const db = database.handle;

  // 4. Catalog and 5. sources + per-user repositories — the same seam the HTTP layer and worker share.
  // 3. Accounts and sessions as managers over providers (yourphr#611): user storage in the app
  // database, passwords by the scrypt provider, the factor list from configuration.
  const users = new UsersManager(engineRef(), new SqliteUsersProvider(db), new PasswordAuthProvider(), { log: (line) => appLog.info(line) });
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
  engine.register('settings', new SettingsManager(engine, { log: (line) => appLog.info(line), dataDir })); // yourphr#618, #619
  engine.register('database', database);
  // Audit (yourphr#614) is REQUIRED: a provider this stack does not have, or one that is not healthy, refuses the boot.
  engine.register('audit', new AuditManager(engine, auditProviderFor(config.getString('audit.provider'), db)));
  engine.register('users', users);
  engine.register('sessions', sessions);
  const recordsManager = new RecordsManager(engine, recordsProvider, new SqliteFavoritesProvider(db));
  engine.register('records', recordsManager);
  // Backups (yourphr#615): the coordinator over OPTIONAL storage; the records door is the exporter.
  engine.register('backups', new BackupManager(engine, backupProviderFor(config.getString('backup.storage.provider')), { dataDir, exporter: recordsManager, alsoExport: [db] }));
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
  const { records, sources, jobs, catalog, audit, backups } = engine.managers;
  // The Records manager names a source for the records that carry its id — asked of the Sources door.
  records.sourceDisplay = (sourceId) => sources.displayOf(sourceId);

  return {
    config, db, dbKey, users, sessions, catalog, sources, jobs, events, audit, backups, engine, records, recordsProvider,
    close: async () => {
      await engine.shutdown(); // the database manager closes the connection, last
    },
  };
}

export interface App {
  server: ReturnType<typeof createYourPhrServer>;
  engine: Engine;
  config: ConfigurationManager;
  users: UsersManager;
  sessions: SessionsManager;
  catalog: CatalogManager;
  sources: SourcesManager;
  jobs: JobsManager;
  audit: AuditManager;
  backups: BackupManager;
  bootstrapPasswordFile?: string;
  syncNow: (now?: number) => Promise<unknown>;
  backupNow: () => Promise<unknown>;
  close: () => Promise<void>;
}

export async function assembleApp(dataDir: string, options: { seeds?: CatalogWrite[]; env?: Record<string, string | undefined>; workerIntervalMs?: number; webDir?: string; version?: string } = {}): Promise<App> {
  const stores = await openStores(dataDir, options.env ?? process.env);
  const { config, users, sessions, catalog, sources, audit, backups, engine, records, events } = stores;
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

  const scheduler = ApiContext.system('scheduler', 'scheduler', engine);
  const backupNow = () => backups.backupNow(scheduler);
  // The scheduler (yourphr#602): once a minute, is a backup due? Outcome recorded by backupNow.
  let lastScheduledMinute: string | undefined;
  const scheduleTimer = options.workerIntervalMs === undefined ? undefined : setInterval(() => {
    const now = new Date();
    if (!backups.due(now, lastScheduledMinute)) return;
    lastScheduledMinute = now.toISOString().slice(0, 16);
    backupNow().then(
      (r) => appLog.info(`scheduled backup written: ${r.file} (${r.sizeBytes} bytes)`),
      (err: Error) => appLog.error(`scheduled backup failed: ${err.message}`)
    );
  }, 60_000);
  scheduleTimer?.unref?.();

  const server = createYourPhrServer({
    engine,
    auth: { cookieMaxAgeSeconds: config.getInt('auth.session.absolute-seconds'), secureCookies: config.getBool('web.secure-cookies') },
    webDir: options.webDir,
    version: options.version,
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
    audit,
    backups,
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
