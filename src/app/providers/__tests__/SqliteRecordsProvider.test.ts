import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { SqliteRecordsProvider } from '../SqliteRecordsProvider.js';
import { SqliteFhirRepository } from '../../../SqliteFhirRepository.js';
import Database from 'better-sqlite3-multiple-ciphers';
import { backupDatabase, stageInstanceRestore, STAGED_APP, STAGED_RECORDS, RECORDS_LEDGER_TABLE } from '../sqlite-backup.js';
import { runMigrations } from '../../../framework/providers/sqlite-migrations.js';

const LOINC = 'http://loinc.org';
const obs = (id: string, code: string, date: string, system = LOINC): Resource =>
  ({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system, code, display: code }] }, effectiveDateTime: date } as Resource);

let dir: string;
let provider: SqliteRecordsProvider;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spike-provider-'));
  provider = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key');
  await provider.initialize();
  const w = provider.writer('alice', 'source-1');
  await w.upsert(obs('o1', '718-7', '2024-01-10'));
  await w.upsert(obs('o2', '718-7', '2024-05-10'));
  await w.upsert(obs('o3', '2345-7', '2024-03-10'));
  await w.upsert(obs('o4', 'BP', '2024-09-10', 'urn:local'));
  await provider.writer('bob', 'source-9').upsert(obs('o9', '718-7', '2025-01-01'));
});
afterEach(async () => { await provider.close(); rmSync(dir, { recursive: true, force: true }); });

describe('SqliteRecordsProvider — PHI storage over SQLCipher, scoped per account', () => {
  it('reads, lists, counts and attributes per account', async () => {
    expect((await provider.read('alice', 'Observation', 'o1'))?.sourceId).toBe('source-1');
    expect(await provider.read('bob', 'Observation', 'o1')).toBeUndefined();
    expect((await provider.readById('alice', 'o3'))?.resourceType).toBe('Observation');
    expect((await provider.list('alice')).map((r) => r.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(await provider.countByType('alice')).toEqual([{ resourceType: 'Observation', count: 4 }]);
    expect(await provider.typesHeld('bob')).toEqual(['Observation']);
    expect([...(await provider.sourceOf('alice', 'Observation')).entries()]).toContainEqual(['o1', 'source-1']);
  });

  it('the writer reports created vs updated, keeps history, and refuses a cross-source collision', async () => {
    const w = provider.writer('alice', 'source-1');
    expect(await w.upsert(obs('o1', '718-7', '2024-01-11'))).toBe('updated');
    expect(await w.upsert(obs('o5', '718-7', '2024-08-01'))).toBe('created');
    expect(await w.exists('Observation', 'o5')).toBe(true);
    const h = await provider.history('alice', 'Observation', 'o1');
    expect(h.versions).toBeGreaterThanOrEqual(2);
    expect(h.firstReceivedAt).not.toBeNull();
    await expect(provider.writer('alice', 'source-2').upsert(obs('o1', '718-7', '2024-01-12'))).rejects.toThrow(/collision/);
  });

  it('a re-sync of an identical record writes nothing: no new version, no history row (yourphr#781)', async () => {
    const w = provider.writer('alice', 'source-1');
    const before = await provider.history('alice', 'Observation', 'o1');
    // What every 15-minute sync pass does: the provider sends the same record again.
    expect(await w.upsert(obs('o1', '718-7', '2024-01-10'))).toBe('unchanged');
    expect(await w.upsert(obs('o1', '718-7', '2024-01-10'))).toBe('unchanged');
    expect((await provider.history('alice', 'Observation', 'o1')).versions).toBe(before.versions);
    // Key order and the provider's own meta stamps are not content.
    const reordered = { effectiveDateTime: '2024-01-10', code: { coding: [{ display: '718-7', code: '718-7', system: 'http://loinc.org' }] }, status: 'final', id: 'o1', resourceType: 'Observation', meta: { versionId: 'provider-v9', lastUpdated: '2030-01-01T00:00:00Z' } } as Resource;
    expect(await w.upsert(reordered)).toBe('unchanged');
    // A real change is one new version, exactly.
    expect(await w.upsert(obs('o1', '718-7', '2024-01-11'))).toBe('updated');
    expect((await provider.history('alice', 'Observation', 'o1')).versions).toBe(before.versions + 1);
  });

  it('an identical record from ANOTHER source is still a collision, not quietly unchanged', async () => {
    await expect(provider.writer('alice', 'source-2').upsert(obs('o1', '718-7', '2024-01-10'))).rejects.toThrow(/collision/);
  });

  it('indexed search: exact token, system|code, system-only prefix, OR within a parameter, AND across; grouped values', async () => {
    const ids = async (where: Parameters<SqliteRecordsProvider['indexedSearch']>[2]) => (await provider.indexedSearch('alice', 'Observation', where)).map((r) => r.id).sort();
    expect(await ids([{ param: 'code', alternatives: ['718-7'] }])).toEqual(['o1', 'o2']);
    expect(await ids([{ param: 'code', alternatives: [`${LOINC}|2345-7`] }])).toEqual(['o3']);
    expect(await ids([{ param: 'code', alternatives: [`${LOINC}|`] }])).toEqual(['o1', 'o2', 'o3']);
    expect(await ids([{ param: 'code', alternatives: ['718-7', '2345-7'] }])).toEqual(['o1', 'o2', 'o3']);
    expect(await ids([{ param: 'code', alternatives: ['718-7'] }, { param: 'date', alternatives: ['ge2024-03-01'] }])).toEqual(['o2']);
    expect(await provider.indexedValues('alice', 'Observation', 'o1', 'code')).toEqual([`${LOINC}|718-7`]);
    await expect(provider.indexedSearch('alice', 'Observation', [{ param: 'bad param', alternatives: ['x'] }])).rejects.toThrow('invalid search parameter');
  });

  it('removes by source and by account, releases a handle, passes integrity, and writes an encrypted backup', async () => {
    expect(await provider.removeBySource('alice', 'source-1')).toBe(4);
    expect(await provider.list('alice')).toEqual([]);
    expect(await provider.list('bob')).toHaveLength(1);
    expect(await provider.removeAll('bob')).toBe(1);
    await provider.release('bob');
    expect(await provider.integrityOk()).toBe(true);
    const b = await provider.backup({ destination: join(dir, 'backups'), key: 'travelling' });
    expect(b.sizeBytes).toBeGreaterThan(0);
  });
});

describe('SqliteRecordsProvider — find anything by words (yourphr#599)', () => {
  it('indexes the record\'s own text into FTS5 on the same write, searches per owner with a snippet, and forgets a deleted record', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'spike-fts-spec-'));
    const provider = new SqliteRecordsProvider(join(dir, 'records.db'), 'at-rest-key');
    await provider.initialize();
    const alice = provider.writer('alice', 'source-1');
    const bob = provider.writer('bob', 'source-9');
    await alice.upsert({ resourceType: 'MedicationStatement', id: 'm1', status: 'active', medicationCodeableConcept: { text: 'Metformin 500 MG oral tablet' }, effectiveDateTime: '2023-06-01' } as never);
    await alice.upsert({ resourceType: 'DocumentReference', id: 'd1', status: 'current', type: { text: 'Cardiology consult note' }, date: '2023-02-10' } as never);
    await bob.upsert({ resourceType: 'MedicationStatement', id: 'm9', status: 'active', medicationCodeableConcept: { text: 'Metformin 1000 MG' } } as never);
    expect((await provider.textSearch('alice', 'metformin', { limit: 10, offset: 0 })).map((h) => h.id)).toEqual(['m1']);
    expect((await provider.textSearch('alice', 'metformin', { limit: 10, offset: 0 }))[0]?.snippet).toMatch(/\[Metformin\]/);
    expect((await provider.textSearch('alice', 'cardio', { limit: 10, offset: 0 })).map((h) => h.id)).toEqual(['d1']); // the last word is a prefix
    expect((await provider.textSearch('bob', 'metformin', { limit: 10, offset: 0 })).map((h) => h.id)).toEqual(['m9']);
    expect(await provider.textSearch('alice', '"; DROP TABLE resources; --', { limit: 10, offset: 0 })).toEqual([]);
    await provider.removeBySource('alice', 'source-1');
    expect(await provider.textSearch('alice', 'metformin', { limit: 10, offset: 0 })).toEqual([]);
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('compact — removing the identical history copies v3.7.2 and earlier wrote (yourphr#781)', () => {
  it('keeps the first copy and every real change, repoints the current version, and touches nothing else', async () => {
    // Build the bloat the old way: updateResource writes a full version every time, as every sync
    // pass did up to v3.7.2. A (x3 identical), then a real change to B (x2 identical).
    const file = join(dir, 'bloated.db');
    const repo = new SqliteFhirRepository({ file, key: 'unit-key', userId: 'carol', sourceId: 'source-1' });
    const A = obs('c1', '718-7', '2024-01-10');
    const B = obs('c1', '718-7', '2024-02-10');
    for (const r of [A, A, A, B, B]) await repo.updateResource(r);
    await repo.updateResource(obs('c2', '2345-7', '2024-03-10')); // one version: nothing to remove
    const p = SqliteRecordsProvider.overRepository(repo);
    const before = await p.history('carol', 'Observation', 'c1');
    expect(before.versions).toBe(5);

    const dry = await p.compact({ dryRun: true });
    expect(dry).toMatchObject({ resources: 2, historyBefore: 6, duplicates: 3, historyAfter: 6, repointed: 1, dryRun: true, vacuumed: false, integrity: 'ok' });
    expect((await p.history('carol', 'Observation', 'c1')).versions).toBe(5);

    const done = await p.compact();
    expect(done).toMatchObject({ resources: 2, historyBefore: 6, duplicates: 3, historyAfter: 3, repointed: 1, dryRun: false, vacuumed: true, integrity: 'ok' });
    const after = await p.history('carol', 'Observation', 'c1');
    expect(after.versions).toBe(2); // A, then B: "changed 1 time", which is the truth
    expect(after.firstReceivedAt).toBe(before.firstReceivedAt);

    // The record reads as it did, and its current version is one that still exists in history.
    const stored = await p.read('carol', 'Observation', 'c1');
    expect((stored?.resource as { effectiveDateTime?: string }).effectiveDateTime).toBe('2024-02-10');
    const versionId = (stored?.resource as { meta?: { versionId?: string } }).meta?.versionId;
    const held = repo.db.prepare('SELECT COUNT(*) AS n FROM resource_history WHERE id = ? AND version_id = ?').get('c1', versionId) as { n: number };
    expect(held.n).toBe(1);
    expect((await p.history('carol', 'Observation', 'c2')).versions).toBe(1);

    // Running it again finds nothing more to do.
    expect(await p.compact()).toMatchObject({ duplicates: 0, repointed: 0, skippedShared: 0, vacuumed: false, integrity: 'ok' });
    repo.db.close();
  });

  it('leaves a record id held by more than one person untouched — their history rows cannot be told apart', async () => {
    const file = join(dir, 'shared.db');
    const carol = new SqliteFhirRepository({ file, key: 'unit-key', userId: 'carol', sourceId: 'source-1' });
    const dave = new SqliteFhirRepository({ file, key: 'unit-key', userId: 'dave', sourceId: 'source-2' });
    const A = obs('same-id', '718-7', '2024-01-10');
    for (const r of [A, A, A]) await carol.updateResource(r);
    for (const r of [A, A]) await dave.updateResource(r);
    await carol.updateResource(obs('only-carol', '718-7', '2024-05-10'));
    await carol.updateResource(obs('only-carol', '718-7', '2024-05-10'));
    const p = SqliteRecordsProvider.overRepository(carol);
    const done = await p.compact();
    expect(done).toMatchObject({ skippedShared: 1, duplicates: 1, integrity: 'ok' }); // only only-carol's repeat goes
    const left = carol.db.prepare("SELECT COUNT(*) AS n FROM resource_history WHERE id = 'same-id'").get() as { n: number };
    expect(left.n).toBe(5); // every row of the shared id is still there
    carol.db.close(); dave.db.close();
  });
});

describe('the records.db migration ledger (yourphr#784)', () => {
  const baseline = { id: '20260927120000', description: 'records baseline', up: () => undefined };

  it('is written on first start, skipped on the next, and leaves the records exactly as they were', async () => {
    await provider.close();
    const ledgered = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key', [baseline]);
    await ledgered.initialize();
    expect(ledgered.migrations).toEqual({ applied: ['20260927120000'], skipped: 0 });
    expect((await ledgered.list('alice')).map((r) => r.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
    await ledgered.close();
    const again = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key', [baseline]);
    await again.initialize();
    expect(again.migrations).toEqual({ applied: [], skipped: 1 });
    await again.close();
    provider = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key');
  });

  it('refuses a records database written by a newer build', async () => {
    await provider.close();
    const newer = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key', [baseline, { id: '20991231000000', description: 'from the future', up: () => undefined }]);
    await newer.initialize();
    await newer.close();
    const older = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key', [baseline]);
    await expect(older.initialize()).rejects.toThrow(/newer than this build.*20991231000000/);
    provider = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key');
  });

  it('with no ledger (the contract harnesses) it never touches the ledger, even on a ledgered file', async () => {
    await provider.close();
    const ledgered = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key', [baseline, { id: '20991231000000', description: 'from the future', up: () => undefined }]);
    await ledgered.initialize();
    await ledgered.close();
    const bare = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key');
    await bare.initialize();
    expect(bare.migrations).toBeUndefined();
    await bare.close();
    provider = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key');
  });
});

describe('backup and restore keep the two ledgers apart (yourphr#784)', () => {
  it('a backup holds both databases\' ledgers, and a restore returns each to its own file', async () => {
    await provider.close();
    const baseline = { id: '20260927120000', description: 'records baseline', up: () => undefined };
    const records = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key', [baseline]);
    await records.initialize();
    await records.close();
    const app = new Database(join(dir, 'spike.db'));
    app.pragma("cipher='sqlcipher'");
    app.pragma("key='unit-key'");
    runMigrations(app, [{ id: '20260820200000', description: 'app baseline', up: () => undefined }]);

    const repo = new SqliteFhirRepository({ file: join(dir, 'records.db'), key: 'unit-key', userId: 'alice' });
    const taken = backupDatabase(repo, { destination: join(dir, 'backups'), backupKey: 'backup-key', alsoExport: [app] });
    repo.db.close();
    app.close();

    stageInstanceRestore(taken.file, 'backup-key', dir, 'unit-key');
    const open = (name: string): InstanceType<typeof Database> => {
      const db = new Database(join(dir, name));
      db.pragma("cipher='sqlcipher'");
      db.pragma("key='unit-key'");
      return db;
    };
    const tables = (db: InstanceType<typeof Database>): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%migrations'").all() as { name: string }[]).map((r) => r.name);
    const stagedRecords = open(STAGED_RECORDS);
    const stagedApp = open(STAGED_APP);
    expect(tables(stagedRecords)).toEqual([RECORDS_LEDGER_TABLE]);
    expect(tables(stagedApp)).toEqual(['schema_migrations']);
    expect((stagedRecords.prepare(`SELECT id FROM ${RECORDS_LEDGER_TABLE}`).all() as { id: string }[]).map((r) => r.id)).toEqual(['20260927120000']);
    expect((stagedApp.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id)).toEqual(['20260820200000']);
    stagedRecords.close();
    stagedApp.close();
    provider = new SqliteRecordsProvider(join(dir, 'records.db'), 'unit-key');
  });
});
