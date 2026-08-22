/**
 * One command, per user, verified: migrate a frozen Go instance into this stack (yourphr#586).
 *
 *   npm run migrate:go -- --go <go.db> --data <spike data dir>
 *                         [--go-key <sqlcipher key>] [--go-data <go data root>]
 *                         [--user <account>] [--go-answers <go-ids.json>] [--allow-internal]
 *
 * --go        the Go database — a COPY taken under the maintenance freeze; opened read-only
 * --data      the spike's data root — the same directory the server is pointed at
 * --go-key    SQLCipher key for an encrypted Go database (also YOURPHR_DB_KEY)
 * --go-data   the Go data root (default: the database's directory) for config/app-custom-config.json
 * --user      migrate one account only
 * --go-answers  TestShadowExport output for --user: the stronger verification, through Go's own
 *               read path rather than its tables
 * --allow-internal  accept catalog URLs the SSRF guard would refuse (loopback sandboxes). Never
 *                   against production.
 *
 * The spike's own settings (SPIKE_DATABASE_ENCRYPTION_KEY, ...) come from the environment exactly
 * as they do for the server, because the stores are opened through the same function.
 *
 * Exit 0 only when the verification agrees for every account and every resource type. Exit 1
 * otherwise — and the report says where. Re-running is safe: every step is one-way.
 */
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { openStores } from '../src/app.js';
import { formatReport, migrateFromGo, openGoDatabase } from '../src/migrate/tool.js';

function arg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}
const has = (flag: string): boolean => process.argv.slice(2).includes(flag);

async function main(): Promise<void> {
  const goPath = arg('--go');
  const dataDir = arg('--data');
  if (!goPath || !dataDir) {
    console.error('usage: npm run migrate:go -- --go <go.db> --data <spike data dir> [--go-key <k>] [--go-data <dir>] [--user <account>] [--go-answers <go-ids.json>] [--allow-internal]');
    process.exit(2);
  }
  const onlyUser = arg('--user');
  const answersPath = arg('--go-answers');
  if (answersPath && !onlyUser) {
    console.error('--go-answers is one account\'s answers; name the account with --user');
    process.exit(2);
  }

  const goResolved = resolve(goPath);
  const wal = goResolved + '-wal';
  if (existsSync(wal) && statSync(wal).size > 0) {
    console.warn(`WARNING: ${wal} is non-empty — is this database still being written? Migrate a copy taken under the freeze.`);
  }

  const goDb = openGoDatabase(goResolved, arg('--go-key') ?? process.env['YOURPHR_DB_KEY']);
  mkdirSync(resolve(dataDir), { recursive: true });
  const stores = await openStores(resolve(dataDir), process.env);

  try {
    const report = await migrateFromGo(goDb, stores, {
      onlyUser,
      goDataDir: resolve(arg('--go-data') ?? dirname(goResolved)),
      allowInternalUrls: has('--allow-internal'),
      goAnswers: answersPath && onlyUser ? { username: onlyUser, answers: JSON.parse(readFileSync(resolve(answersPath), 'utf8')) as Record<string, string[]> } : undefined,
      log: (line) => console.log(`-> ${line}`),
    });
    console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    stores.close();
    goDb.close();
  }
}

main().catch((err) => {
  console.error(`migration failed: ${(err as Error).message}`);
  process.exit(1);
});
