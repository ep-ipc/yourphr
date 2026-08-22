import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { SqliteRecordsProvider } from '../SqliteRecordsProvider.js';

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
