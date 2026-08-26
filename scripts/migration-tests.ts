/**
 * Migration-system harness (yourphr#542). Loopback only, synthetic schema, no PHI.
 *
 * The two load-bearing checks: a failing migration ROLLS BACK and later reruns resume exactly
 * there, and a database from the future is REFUSED rather than opened best-effort. Plus the
 * yourphr#528 regression as a living test: a counter column added to a table with existing rows
 * must increment from zero, not sit at NULL forever.
 *
 *   npm run migrations
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations, addColumnWithDefault, type Migration } from '../src/framework/providers/sqlite-migrations.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const M1: Migration = {
  id: '20260820000001',
  description: 'create accounts',
  up: (db) => db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'),
};
const M2: Migration = {
  id: '20260820000002',
  description: 'seed one account',
  up: (db) => db.exec("INSERT INTO accounts (name) VALUES ('existing-row')"),
};
// The #528 shape: a counter column arriving AFTER rows exist.
const M3: Migration = {
  id: '20260820000003',
  description: 'add token_generation with default AND backfill (#528)',
  up: (db) => addColumnWithDefault(db, 'accounts', 'token_generation', 'INTEGER', 0),
};

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'spike-migrations-'));

  // --- fresh database: everything applies, in order, recorded ---
  {
    const db = new Database(join(dir, 'fresh.db'));
    const first = runMigrations(db, [M1, M2, M3]);
    check('a fresh database applies every migration in order', first.applied.length === 3 && first.skipped === 0);

    const again = runMigrations(db, [M1, M2, M3]);
    check('a rerun applies nothing (run-once, recorded)', again.applied.length === 0 && again.skipped === 3);

    const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[];
    check('the ledger records exactly the applied ids', rows.map((r) => r.id).join(',') === '20260820000001,20260820000002,20260820000003');

    // --- the #528 regression, alive ---
    const value = db.prepare("SELECT token_generation FROM accounts WHERE name = 'existing-row'").get() as { token_generation: number | null };
    check('a counter column on a PRE-EXISTING row is 0, not NULL (#528)', value.token_generation === 0);
    db.prepare("UPDATE accounts SET token_generation = token_generation + 1 WHERE name = 'existing-row'").run();
    const bumped = db.prepare("SELECT token_generation FROM accounts WHERE name = 'existing-row'").get() as { token_generation: number | null };
    check('and incrementing it actually moves it (NULL + 1 would silently stay NULL)', bumped.token_generation === 1);
    db.close();
  }

  // --- failure: rollback, stop, resume ---
  {
    const db = new Database(join(dir, 'failing.db'));
    const BAD: Migration = {
      id: '20260820000002',
      description: 'writes then explodes',
      up: (d) => {
        d.exec("CREATE TABLE half_done (id INTEGER PRIMARY KEY)");
        d.exec("INSERT INTO half_done (id) VALUES (1)");
        d.exec('SELECT * FROM no_such_table');
      },
    };
    let error = '';
    try { runMigrations(db, [M1, BAD]); } catch (err) { error = (err as Error).message; }
    check('a failing migration stops the run and names its id', error.includes('20260820000002') && error.includes('rolled back'));

    const halfDone = db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get();
    check('its partial work is ROLLED BACK — nothing half-applied survives', halfDone === undefined);
    const ledger = (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id);
    check('everything BEFORE the failure stays applied', ledger.join(',') === '20260820000001');

    const FIXED: Migration = { ...BAD, description: 'fixed', up: (d) => d.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY)') };
    const resumed = runMigrations(db, [M1, FIXED, M3 ]);
    check('a rerun after the fix resumes exactly where it stopped',
      resumed.skipped === 1 && resumed.applied.join(',') === '20260820000002,20260820000003');
    db.close();
  }

  // --- downgrade protection ---
  {
    const db = new Database(join(dir, 'future.db'));
    runMigrations(db, [M1, M2]);
    db.prepare("INSERT INTO schema_migrations (id, description, applied_at) VALUES ('20990101000000', 'from a newer build', 'later')").run();
    let refused = '';
    try { runMigrations(db, [M1, M2]); } catch (err) { refused = (err as Error).message; }
    check('a database from the FUTURE is refused, naming the unknown migration',
      refused.includes('newer than this build') && refused.includes('20990101000000'));
    db.close();
  }

  // --- registry hygiene ---
  {
    const db = new Database(join(dir, 'hygiene.db'));
    let misordered = false;
    try { runMigrations(db, [M2, M1]); } catch { misordered = true; }
    check('a misordered registry is refused before touching the database', misordered);
    let badId = false;
    try { runMigrations(db, [{ id: 'not-a-date', description: 'x', up: () => undefined }]); } catch { badId = true; }
    check('a non-dated id is refused', badId);
    db.close();
  }

  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main();
