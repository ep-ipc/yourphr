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
 * Roles, honestly scoped: the operator is the BOOTSTRAP admin account. A real role column is
 * Phase-5 work (it touches migration of Go's users table); a single-operator household is the
 * deployment this spike models, and the gate is a named simplification, not an accident.
 */
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { ConfigStore } from './config/index.js';
import { runMigrations, type Migration } from './migrations/index.js';
import { AuthStore } from './auth/index.js';
import { ProviderCatalog, type CatalogWrite } from './catalog/index.js';
import { SourceStore, runSyncPass } from './worker/index.js';
import { backupDatabase } from './backup/index.js';
import { buildIps } from './ips/index.js';
import { provenanceFor } from './provenance/index.js';
import { reconcile, type MedInput } from './medication/index.js';
import { createYourPhrServer } from './server.js';
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
];

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

export function assembleApp(dataDir: string, options: { seeds?: CatalogWrite[]; env?: Record<string, string | undefined>; workerIntervalMs?: number; webDir?: string } = {}): App {
  // 1. Config — everything below reads it.
  const config = new ConfigStore(dataDir, undefined, options.env ?? process.env);
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

  // 3. Auth, policies from configuration; bootstrap the first admin on an empty install.
  const auth = new AuthStore(db, {
    sessionKey: randomBytes(32),
    session: { slidingSeconds: config.getInt('auth.session.sliding-seconds'), absoluteSeconds: config.getInt('auth.session.absolute-seconds') },
    throttle: { maxFailures: config.getInt('auth.throttle.max-failures'), windowSeconds: config.getInt('auth.throttle.window-seconds') },
    minPasswordLength: config.getInt('auth.password.min-length'),
    trustedProxies: config.getStringList('auth.trusted-proxies'),
  });
  const bootstrap = auth.bootstrapAdmin(dataDir);

  // 4. Catalog, provision-then-preserve.
  const catalog = new ProviderCatalog(db);
  if (options.seeds) {
    catalog.seed(options.seeds);
  }

  // 5. Sources + per-user repositories — the same seam the HTTP layer and worker share.
  const sources = new SourceStore(db);
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

  const sourceDisplay = (sourceId: string): string => {
    const numeric = Number(sourceId.replace('source-', ''));
    return sources.list().find((s) => s.id === numeric)?.display ?? '';
  };

  const server = createYourPhrServer({
    repo: repoForUser('__unused__'), // never serves: auth is wired, every request resolves its own repo
    auth: { store: auth, repoForUser },
    webDir: options.webDir,
    modules: {
      ips: (repo) => buildIps(repo, new Date()).then((d) => d.bundle),
      provenanceFor: (repo, resourceType, id) =>
        provenanceFor({ db: repo.db, userId: repo.userId ?? '', sourceDisplay }, resourceType, id),
      medications,
      admin: {
        isAdmin: (username) => username === 'admin', // the named simplification — see module header
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
      for (const repo of repos.values()) repo.db.close();
      db.close();
    },
  };
}
