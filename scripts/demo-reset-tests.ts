/**
 * The demo reset (yourphr#645) — the one code path in this product that deliberately destroys a
 * live database, so the tests that matter are the REFUSALS.
 *
 *   npm run demo-reset
 *
 * Each case builds a real pair of databases on disk and calls the same function the boot calls, then
 * asserts what is left behind. Nothing is mocked: a refusal that leaves data intact is only worth
 * believing if the data is checked afterwards.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { applyDemoReset, BASELINE_APP, BASELINE_RECORDS, baselineIsPresent } from '../src/demo/reset.js';
import { assembleApp } from '../src/app.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yourphr-demo-reset-'));
  dirs.push(dir);
  return dir;
}

/** A database holding the given accounts and one marker row, so "untouched" can be proven. */
function makeDb(path: string, accounts: string[], marker: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE auth_users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, token_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'user\')');
  db.exec('CREATE TABLE marker (value TEXT)');
  const insert = db.prepare('INSERT INTO auth_users (username, password_hash, created_at) VALUES (?, ?, ?)');
  for (const account of accounts) insert.run(account, 'hash', '2026-01-01T00:00:00Z');
  db.prepare('INSERT INTO marker (value) VALUES (?)').run(marker);
  db.close();
}

function markerOf(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT value FROM marker').get() as { value: string } | undefined)?.value ?? '(none)';
  } finally {
    db.close();
  }
}

/** A baseline directory whose databases are recognisable by their marker. */
function makeBaseline(): string {
  const dir = scratch();
  makeDb(join(dir, BASELINE_APP), ['demo', 'admin'], 'BASELINE');
  makeDb(join(dir, BASELINE_RECORDS), [], 'BASELINE');
  return dir;
}

function request(overrides: Partial<Parameters<typeof applyDemoReset>[0]> & { appDbPath: string; recordsDbPath: string; baselineDir: string }) {
  return applyDemoReset({
    demoEnabled: true,
    resetOnRestart: true,
    databaseKey: '',
    allowedAccounts: ['demo', 'admin'],
    log: () => undefined,
    ...overrides,
  });
}

function main(): void {
  const baseline = makeBaseline();
  check('the builder writes a baseline the reset recognises', baselineIsPresent(baseline));

  // 1. The happy path: armed, proven, restored.
  {
    const live = scratch();
    const app = join(live, 'spike.db');
    const records = join(live, 'records.db');
    makeDb(app, ['demo', 'admin'], 'WHAT-A-VISITOR-LEFT');
    makeDb(records, [], 'WHAT-A-VISITOR-LEFT');
    const outcome = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline });
    check('an armed, proven instance is restored to the baseline — both databases',
      outcome.applied && markerOf(app) === 'BASELINE' && markerOf(records) === 'BASELINE',
      `app ${markerOf(app)}, records ${markerOf(records)}`);
  }

  // 2. THE IMPORTANT ONE. A database holding any account this demo does not own is refused, and
  //    every byte of it is still there afterwards.
  {
    const live = scratch();
    const app = join(live, 'spike.db');
    const records = join(live, 'records.db');
    makeDb(app, ['demo', 'admin', 'jim'], 'SOMEBODY-REAL');
    makeDb(records, [], 'SOMEBODY-REAL');
    const outcome = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline });
    check('a database holding ANY non-demo account is refused and left untouched',
      !outcome.applied && outcome.reason === 'foreign-account' && markerOf(app) === 'SOMEBODY-REAL' && markerOf(records) === 'SOMEBODY-REAL',
      `${outcome.applied ? 'APPLIED' : outcome.reason}, app ${markerOf(app)}`);
  }

  // 3. Encryption refuses outright: the baseline is plaintext and could not be written under a key.
  {
    const live = scratch();
    const app = join(live, 'spike.db');
    const records = join(live, 'records.db');
    makeDb(app, ['demo'], 'ENCRYPTED-INSTANCE');
    makeDb(records, [], 'ENCRYPTED-INSTANCE');
    const outcome = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline, databaseKey: 'at-rest-key' });
    check('an encrypted instance is refused outright and left untouched',
      !outcome.applied && outcome.reason === 'encrypted' && markerOf(app) === 'ENCRYPTED-INSTANCE');
  }

  // 4. Each switch alone destroys nothing.
  {
    const live = scratch();
    const app = join(live, 'spike.db');
    const records = join(live, 'records.db');
    makeDb(app, ['demo'], 'NOT-ARMED');
    makeDb(records, [], 'NOT-ARMED');
    const offDemo = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline, demoEnabled: false });
    const offReset = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline, resetOnRestart: false });
    const noBaseline = request({ appDbPath: app, recordsDbPath: records, baselineDir: join(live, 'nothing-here') });
    check('demo mode off, reset off, or no baseline: each refuses on its own and destroys nothing',
      !offDemo.applied && !offReset.applied && !noBaseline.applied && markerOf(app) === 'NOT-ARMED',
      `${offDemo.applied ? 'x' : offDemo.reason} / ${offReset.applied ? 'x' : offReset.reason} / ${noBaseline.applied ? 'x' : noBaseline.reason}`);
  }

  // 5. An unreadable database is not a proven one.
  {
    const live = scratch();
    const app = join(live, 'spike.db');
    const records = join(live, 'records.db');
    copyFileSync(join(baseline, BASELINE_RECORDS), records);
    // A file that is not a database at all — the shape a truncated volume or a half-copied file has.
    const db = new Database(app);
    db.exec('CREATE TABLE something_else (x TEXT)');
    db.close();
    const outcome = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline });
    check('a database whose accounts cannot be read is refused rather than assumed safe',
      !outcome.applied && outcome.reason === 'unreadable' && existsSync(app));
  }

  // 6. A first boot has nothing to prove and nothing to lose.
  {
    const live = scratch();
    const outcome = request({ appDbPath: join(live, 'spike.db'), recordsDbPath: join(live, 'records.db'), baselineDir: baseline });
    check('a first boot installs the baseline without a database to prove',
      outcome.applied && markerOf(join(live, 'spike.db')) === 'BASELINE');
  }

  // 7. A stale write-ahead log is removed with the file it belonged to.
  {
    const live = scratch();
    const app = join(live, 'spike.db');
    const records = join(live, 'records.db');
    makeDb(app, ['demo'], 'OLD');
    makeDb(records, [], 'OLD');
    const wal = `${app}-wal`;
    copyFileSync(app, wal); // any leftover file by that name is enough to prove it is cleared
    const outcome = request({ appDbPath: app, recordsDbPath: records, baselineDir: baseline });
    check('the previous instance\'s -wal is cleared, so SQLite cannot replay it onto the baseline',
      outcome.applied && !existsSync(wal) && markerOf(app) === 'BASELINE');
  }

  void sessionsDieAcrossARestart().then(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed > 0) process.exit(1);
  });
}

/**
 * The requirement behind "a visitor who signs in after a reset gets a sign-in page, not a token
 * error": a token minted before the restart must not verify after it. Go maintains this by deleting
 * its JWT signing key during the reset; here it falls out of the session key being generated at
 * every boot, which is worth PROVING rather than assuming, because the day someone persists that
 * key to make sessions survive restarts, this is the property they would silently break.
 */
async function sessionsDieAcrossARestart(): Promise<void> {
  const dir = scratch();
  const env = { YOURPHR_DATABASE_ENCRYPTION_KEY: '', YOURPHR_BACKUP_ENCRYPTION_KEY: 'travelling-copy-key' };
  const first = await assembleApp(dir, { env });
  const token = await first.sessions.issueFor('admin');
  const goodBefore = token ? (await first.sessions.verify(token)).ok : false;
  await first.close();

  const second = await assembleApp(dir, { env });
  const goodAfter = token ? (await second.sessions.verify(token)).ok : false;
  await second.close();

  check('a session minted before a restart does not verify after one — the reset needs no key surgery',
    goodBefore && !goodAfter, `before ${goodBefore}, after ${goodAfter}`);
}

main();
