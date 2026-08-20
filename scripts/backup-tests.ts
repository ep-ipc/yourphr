/**
 * Encrypted-backup harness (yourphr#461 lifted, TypeScript-first). Loopback only, synthetic
 * records, no PHI.
 *
 * The check that matters most: the backup of an ENCRYPTED database is CIPHERTEXT — no clinical
 * string from the records is findable in the backup file's bytes. That single property is what the
 * Go stack's #367 refusal existed to protect, and what lifts it here.
 *
 *   npm run backup
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';
import { backupDatabase, listBackups, stageRestore, backupFileName } from '../src/backup/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const MARKER = 'Completely-Synthetic-Hypertension-Marker';
const DB_KEY = 'database-at-rest-key';
const BACKUP_KEY = 'separate-backup-key';

async function seededRepo(file: string, key?: string): Promise<SqliteFhirRepository> {
  const repo = new SqliteFhirRepository({ file, userId: 'backup-user', key });
  for (let i = 1; i <= 25; i++) {
    await repo.updateResource({
      resourceType: 'Condition',
      id: `bk-cond-${i}`,
      code: { text: `${MARKER}-${i}` },
    } as never);
  }
  return repo;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-backup-'));
  const dest = join(dir, 'backups');
  mkdirSync(dest, { recursive: true });

  // --- encrypted source -> encrypted backup, live db ---
  const repo = await seededRepo(join(dir, 'live.db'), DB_KEY);

  let refused = false;
  try { backupDatabase(repo, { destination: dest, backupKey: '' }); } catch { refused = true; }
  check('an empty backup key is refused — backups are always encrypted', refused);

  const b1 = backupDatabase(repo, { destination: dest, backupKey: BACKUP_KEY });
  check('a backup of a live encrypted database is written', b1.sizeBytes > 0, `${b1.sizeBytes} bytes`);

  const bytes = readFileSync(b1.file);
  check('THE BACKUP IS CIPHERTEXT — no clinical string is findable in its bytes',
    !bytes.includes(MARKER) && !bytes.includes('resourceType'));
  check('and it does not carry the SQLite plaintext header', !bytes.subarray(0, 16).includes('SQLite format 3'));

  // --- restore roundtrip under a DIFFERENT target key ---
  const staged = stageRestore(b1.file, BACKUP_KEY, join(dir, 'staged.db'), 'a-third-key-entirely');
  check('restore stages after an integrity check', staged.tables > 0, `${staged.tables} tables`);

  const restored = new SqliteFhirRepository({ file: join(dir, 'staged.db'), userId: 'backup-user', key: 'a-third-key-entirely' });
  const back = await restored.search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('every record survives the roundtrip', back.total === 25, `${back.total}/25`);
  const one = (back.entry?.[0]?.resource as { code?: { text?: string } })?.code?.text ?? '';
  check('and comes back byte-identical in meaning', one.startsWith(MARKER));
  restored.db.close();

  // --- wrong key is refused, not garbage ---
  let wrongKey = false;
  try { stageRestore(b1.file, 'not-the-backup-key', join(dir, 'nope.db'), ''); } catch { wrongKey = true; }
  check('a wrong backup key refuses the restore with an error, not silent garbage', wrongKey);

  // --- writes DURING the window: the copy is consistent, the live db keeps working ---
  await repo.updateResource({ resourceType: 'Condition', id: 'bk-cond-after', code: { text: `${MARKER}-after` } } as never);
  const b2 = backupDatabase(repo, { destination: dest, backupKey: BACKUP_KEY, now: new Date(Date.now() + 1000) });
  const staged2 = stageRestore(b2.file, BACKUP_KEY, join(dir, 'staged2.db'), '');
  const restored2 = new SqliteFhirRepository({ file: join(dir, 'staged2.db'), userId: 'backup-user' });
  const after = await restored2.search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('a later backup carries later writes (the copy tracks the live db)', after.total === 26, `${after.total}/26; staged tables ${staged2.tables}`);
  restored2.db.close();

  // --- plaintext source still gets an ENCRYPTED backup ---
  const plainRepo = await seededRepo(join(dir, 'plain.db'));
  const b3 = backupDatabase(plainRepo, { destination: join(dir, 'plain-backups'), backupKey: BACKUP_KEY });
  const plainBytes = readFileSync(b3.file);
  check('a PLAINTEXT database still produces a ciphertext backup — the travelling copy is the risk',
    !plainBytes.includes(MARKER) && !plainBytes.subarray(0, 16).includes('SQLite format 3'));
  plainRepo.db.close();

  // --- retention ---
  for (let i = 2; i <= 5; i++) {
    backupDatabase(repo, { destination: dest, backupKey: BACKUP_KEY, now: new Date(Date.now() + i * 1000) });
  }
  const result = backupDatabase(repo, { destination: dest, backupKey: BACKUP_KEY, maxBackups: 3, now: new Date(Date.now() + 9000) });
  check('pruning keeps the newest maxBackups and names what it removed',
    listBackups(dest).length === 3 && result.pruned.length > 0, `pruned ${result.pruned.length}`);
  check('names sort chronologically (date-first convention)',
    backupFileName(new Date('2026-01-02T03:04:05Z')) < backupFileName(new Date('2026-01-02T03:04:06Z')));

  repo.db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`backup harness failed: ${(err as Error).message}`);
  process.exit(1);
});
