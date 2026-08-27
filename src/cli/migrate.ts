/**
 * `migrate` — one command, per user, verified: a frozen Go instance into this stack (yourphr#586),
 * reachable from the image rather than only from a source checkout (yourphr#654).
 *
 *   yourphr migrate --go <go.db> --data <data dir>
 *                   [--go-key <sqlcipher key>] [--go-data <go data root>]
 *                   [--user <account>] [--go-answers <go-ids.json>] [--allow-internal]
 *
 * --go        the Go database — a COPY taken under the maintenance freeze; opened read-only
 * --data      this stack's data root — the same directory the server is pointed at
 * --go-key    SQLCipher key for an encrypted Go database (also YOURPHR_DB_KEY)
 * --go-data   the Go data root (default: the database's directory) for config/app-custom-config.json
 * --user      migrate one account only
 * --go-answers  TestShadowExport output for --user: the stronger verification, through Go's own
 *               read path rather than its tables
 * --allow-internal  accept catalog URLs the SSRF guard would refuse (loopback sandboxes). Never
 *                   against production.
 *
 * Exit 0 only when the verification agrees for every account and every resource type. Exit 1
 * otherwise — and the report says where. Re-running is safe: every step is one-way.
 */
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import dotenv from 'dotenv';
import { openStores } from '../app.js';
import { formatReport, migrateFromGo, openGoDatabase } from '../migrate/tool.js';
import { flag, has, unknownFlags } from './args.js';

const VALUED = ['--go', '--data', '--go-key', '--go-data', '--user', '--go-answers'] as const;
const VALUELESS = ['--allow-internal'] as const;

export const MIGRATE_USAGE =
  'usage: yourphr migrate --go <go.db> --data <data dir> [--go-key <key>] [--go-data <dir>] [--user <account>] [--go-answers <file>] [--allow-internal]';

const EX_USAGE = 2;

export async function migrate(argv: string[]): Promise<number> {
  const unknown = unknownFlags(argv, VALUED, VALUELESS);
  if (unknown.length > 0) {
    console.error(`migrate: unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${unknown.join(' ')}\n${MIGRATE_USAGE}`);
    return EX_USAGE;
  }

  const goPath = flag(argv, '--go');
  const dataDir = flag(argv, '--data');
  if (!goPath || !dataDir) {
    console.error(MIGRATE_USAGE);
    return EX_USAGE;
  }
  const onlyUser = flag(argv, '--user');
  const answersPath = flag(argv, '--go-answers');
  if (answersPath && !onlyUser) {
    console.error("--go-answers is one account's answers; name the account with --user");
    return EX_USAGE;
  }

  const goResolved = resolve(goPath);
  const wal = goResolved + '-wal';
  if (existsSync(wal) && statSync(wal).size > 0) {
    console.warn(`WARNING: ${wal} is non-empty — is this database still being written? Migrate a copy taken under the freeze.`);
  }

  const dataResolved = resolve(dataDir);
  // The receiving instance's own .env, where the at-rest keys live since yourphr#630.
  //
  // bootstrap-env has already applied `<YOURPHR_FAST_STORAGE>/.env`, and for the documented
  // `docker run … migrate` that IS this directory — the image points both at /opt/yourphr/data.
  // It is not, when --data names somewhere else, and then the keys would be absent and the
  // migration would spend its whole run writing an UNENCRYPTED database that the server
  // afterwards refuses to open. Loud, but only after the records had already moved.
  //
  // dotenv never overrides a variable that is already set, so the ambient environment still wins,
  // exactly as bootstrap-env documents.
  dotenv.config({ path: join(dataResolved, '.env'), quiet: true });

  const goDb = openGoDatabase(goResolved, flag(argv, '--go-key') ?? process.env['YOURPHR_DB_KEY']);
  mkdirSync(dataResolved, { recursive: true });
  const stores = await openStores(dataResolved, process.env);

  try {
    const report = await migrateFromGo(goDb, stores, {
      onlyUser,
      goDataDir: resolve(flag(argv, '--go-data') ?? dirname(goResolved)),
      allowInternalUrls: has(argv, '--allow-internal'),
      goAnswers: answersPath && onlyUser ? { username: onlyUser, answers: JSON.parse(readFileSync(resolve(answersPath), 'utf8')) as Record<string, string[]> } : undefined,
      log: (line) => console.log(`-> ${line}`),
    });
    console.log(formatReport(report));
    return report.ok ? 0 : 1;
  } finally {
    await stores.close();
    goDb.close();
  }
}
