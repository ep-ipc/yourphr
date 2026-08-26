/**
 * Criterion 3: does an encrypted database actually round-trip, and is it actually encrypted?
 *
 * A PHR that believes it encrypts and does not is worse than one that never claimed to, so this
 * asserts both directions: the right key reads, and the absence of a key FAILS. It also greps the
 * raw file for a known plaintext string, because "the driver returned rows" is not proof that the
 * bytes on disk are ciphertext.
 *
 *   npm run roundtrip
 */
import type { Patient } from '@medplum/fhirtypes';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';

const FILE = resolve('phi/roundtrip.db');
const KEY = 'spike-test-key-not-a-real-secret';
const MARKER = 'Wolverine';

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(FILE + suffix)) {
      rmSync(FILE + suffix);
    }
  }
}

function check(label: string, passed: boolean, detail = ''): boolean {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return passed;
}

async function main(): Promise<void> {
  cleanup();
  const results: boolean[] = [];

  // 1. Write through the repository with a key.
  const repo = new SqliteFhirRepository({ file: FILE, key: KEY });
  const patient: Patient = {
    resourceType: 'Patient',
    id: 'roundtrip-1',
    name: [{ family: MARKER, given: ['Logan'] }],
  };
  await repo.createResource(patient);
  repo.db.close();

  // 2. The right key reads it back, indexes and all.
  try {
    const reopened = new SqliteFhirRepository({ file: FILE, key: KEY });
    const read = await reopened.readResource<Patient>('Patient', 'roundtrip-1');
    results.push(check('reopen with the correct key', read.name?.[0]?.family === MARKER));

    const found = await reopened.search<Patient>({
      resourceType: 'Patient',
      filters: [{ code: 'family', operator: 'eq', value: MARKER.toLowerCase() }],
    });
    results.push(check('search works on the encrypted database', found.total === 1, `total=${found.total}`));
    reopened.db.close();
  } catch (err) {
    results.push(check('reopen with the correct key', false, (err as Error).message));
  }

  // 3. No key must FAIL. If this passes, the database was never encrypted.
  let openedWithoutKey = false;
  try {
    const db = new Database(FILE);
    db.prepare('SELECT COUNT(*) FROM resources').get();
    openedWithoutKey = true;
    db.close();
  } catch {
    openedWithoutKey = false;
  }
  results.push(check('reading WITHOUT the key fails', !openedWithoutKey));

  // 4. The wrong key must fail too.
  let openedWithWrongKey = false;
  try {
    const db = new Database(FILE);
    db.pragma("cipher='sqlcipher'");
    db.pragma("key='definitely-the-wrong-key'");
    db.prepare('SELECT COUNT(*) FROM resources').get();
    openedWithWrongKey = true;
    db.close();
  } catch {
    openedWithWrongKey = false;
  }
  results.push(check('reading with the WRONG key fails', !openedWithWrongKey));

  // 5. The bytes on disk must not contain the plaintext.
  const raw = readFileSync(FILE);
  results.push(
    check(`"${MARKER}" does not appear in the raw file`, !raw.includes(Buffer.from(MARKER, 'utf8')))
  );

  cleanup();

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
