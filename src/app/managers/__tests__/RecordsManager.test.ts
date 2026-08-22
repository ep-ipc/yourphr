import { beforeEach, describe, expect, it } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { Engine } from '../../../framework/Engine.js';
import { ApiContext, ApiError } from '../../../framework/ApiContext.js';
import { RecordsManager, type AggregationRow } from '../RecordsManager.js';
import { FakeRecordsProvider } from '../../providers/__tests__/FakeRecordsProvider.js';
import { FakeFavoritesProvider } from '../../providers/__tests__/FakeFavoritesProvider.js';

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const obs = (id: string, code: string, display: string, date: string, system = LOINC): Resource =>
  ({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system, code, display }] }, effectiveDateTime: date } as Resource);

let provider: FakeRecordsProvider;
let favorites: FakeFavoritesProvider;
let engine: Engine;
let records: RecordsManager;
let alice: ApiContext;
let bob: ApiContext;

beforeEach(async () => {
  provider = new FakeRecordsProvider();
  favorites = new FakeFavoritesProvider();
  engine = new Engine();
  records = new RecordsManager(engine, provider, favorites);
  engine.register('records', records);
  await engine.initialize();
  alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  bob = ApiContext.from({ username: 'bob', role: 'user' }, engine);
  provider.seed('alice', 'source-1', obs('o1', '718-7', 'Hemoglobin', '2024-01-10'));
  provider.seed('alice', 'source-1', obs('o2', '718-7', 'Hemoglobin', '2024-05-10'));
  provider.seed('alice', 'source-2', obs('o3', '2345-7', 'Glucose', '2024-03-10'));
  provider.seed('alice', 'source-1', { resourceType: 'Condition', id: 'c1', code: { text: 'Hypertension', coding: [{ system: SNOMED, code: '38341003' }] }, clinicalStatus: { coding: [{ code: 'active' }] }, recordedDate: '2024-07-01' } as Resource);
  provider.seed('alice', '', { resourceType: 'Condition', id: 'c2', code: { text: 'Typed in' } } as Resource);
  provider.seed('bob', 'source-9', obs('o9', '718-7', 'Hemoglobin', '2025-01-01'));
});

describe('RecordsManager — the one door, scoped to whoever is asking', () => {
  it('initialises its provider with the engine and closes it on shutdown', async () => {
    expect(provider.initialized).toBe(true);
    await engine.shutdown();
    expect(provider.closed).toBe(true);
  });

  it('refuses an anonymous caller on every read', async () => {
    const nobody = ApiContext.anonymous(engine);
    await expect(records.list(nobody, 'Observation')).rejects.toBeInstanceOf(ApiError);
    await expect(records.countsByType(nobody)).rejects.toMatchObject({ status: 401 });
  });

  it('lists in resource_fhir shape with the real source attribution, and ?sourceID narrows', async () => {
    const all = await records.list(alice, 'Observation');
    expect(all.map((r) => r['source_resource_id'])).toEqual(['o1', 'o2', 'o3']);
    expect(all.map((r) => r['source_id'])).toEqual(['source-1', 'source-1', 'source-2']);
    expect((await records.list(alice, 'Observation', { sourceId: 'source-2' })).map((r) => r['source_resource_id'])).toEqual(['o3']);
    expect(await records.list(bob, 'Observation')).toHaveLength(1);
  });

  it('detail finds a record by id without its type; a missing one is a 404', async () => {
    expect((await records.detail(alice, 'c1'))['source_resource_type']).toBe('Condition');
    await expect(records.detail(alice, 'o9')).rejects.toMatchObject({ status: 404 }); // bob's
  });

  it('counts by type, per source, and the types held', async () => {
    expect(await records.countsByType(alice)).toEqual([{ resource_type: 'Condition', count: 2 }, { resource_type: 'Observation', count: 3 }]);
    expect(await records.sourceCounts(alice, 'source-1')).toEqual([{ source_id: 'source-1', resource_type: 'Condition', count: 1 }, { source_id: 'source-1', resource_type: 'Observation', count: 2 }]);
    expect(await records.typesHeld(alice)).toEqual(['Condition', 'Observation']);
  });

  it('recent: newest first across types, limited', async () => {
    const recent = await records.recent(alice, 2);
    expect(recent.map((r) => `${r.source_resource_type}/${r.source_resource_id}@${r.date}`)).toEqual(['Condition/c1@2024-07-01', 'Observation/o2@2024-05-10']);
  });

  it('the typed query: grouped by code with max(sort_date), system-only tokens, count_by, and refusals', async () => {
    const grouped = (await records.query(alice, { from: 'Observation', where: { code: `${LOINC}|` }, aggregations: { order_by: { field: 'sort_date', fn: 'max' }, group_by: { field: 'code' } } })) as AggregationRow[];
    expect(grouped).toEqual([{ label: `${LOINC}|718-7`, value: '2024-05-10' }, { label: `${LOINC}|2345-7`, value: '2024-03-10' }]);
    const rows = (await records.query(alice, { from: 'Observation', where: { code: '718-7,2345-7' } })) as Record<string, unknown>[];
    expect(rows.map((r) => r['source_resource_id'])).toEqual(['o2', 'o3', 'o1']);
    const counted = (await records.query(alice, { from: 'Observation', aggregations: { count_by: { field: 'code' } } })) as AggregationRow[];
    expect(counted[0]).toEqual({ label: `${LOINC}|718-7`, value: 2 });
    await expect(records.query(alice, { from: 'Observation; DROP TABLE x' })).rejects.toMatchObject({ status: 400 });
    await expect(records.query(alice, { from: 'Observation', where: { 'bad param': 'x' } })).rejects.toMatchObject({ status: 400 });
    await expect(records.query(alice, { from: 'Observation', aggregations: { group_by: { field: 'code' }, order_by: { field: 'issued' } } })).rejects.toMatchObject({ status: 400 });
  });

  it('the views run over the caller\'s records only', async () => {
    const conditions = await records.conditions(alice);
    expect(conditions.map((c) => c.sourceResourceId)).toEqual(['c1', 'c2']);
    expect(conditions[0]?.state).toBe('Active');
    expect(await records.conditions(bob)).toEqual([]);
    expect(await records.allergies(alice)).toEqual([]);
    expect(await records.medications(alice)).toEqual([]);
  });

  it('provenance names the source through the app-supplied display, or the raw id, or this instance', async () => {
    records.sourceDisplay = (id) => (id === 'source-1' ? 'Fake Regional' : '');
    expect((await records.provenance(alice, 'Condition', 'c1'))?.sourceDisplay).toBe('Fake Regional');
    expect((await records.provenance(alice, 'Observation', 'o3'))?.sourceDisplay).toBe('source-2');
    expect((await records.provenance(alice, 'Condition', 'c2'))?.sourceDisplay).toBe('This instance (manual entry or upload)');
    expect(await records.provenance(bob, 'Condition', 'c1')).toBeUndefined();
  });

  it('the writer upserts for the caller and one source, and a cross-source collision is refused', async () => {
    const w = records.writer(alice, 'source-1');
    expect(await w.upsert(obs('o1', '718-7', 'Hemoglobin', '2024-01-11'))).toBe('updated');
    expect(await w.upsert(obs('o5', '718-7', 'Hemoglobin', '2024-08-01'))).toBe('created');
    await expect(records.writer(alice, 'source-2').upsert(obs('o1', '718-7', 'x', '2024-01-12'))).rejects.toThrow('cross-source id collision');
    expect(await records.exists(alice, 'Observation', 'o5')).toBe(true);
    expect(await records.exists(bob, 'Observation', 'o5')).toBe(false);
  });

  it('export, remove by source, and remove all (which releases the handle) act on the caller only', async () => {
    expect((await records.exportSource(alice, 'source-1')).total).toBe(3);
    expect(await records.removeSource(alice, 'source-1')).toBe(3);
    expect(await records.countsByType(alice)).toEqual([{ resource_type: 'Condition', count: 1 }, { resource_type: 'Observation', count: 1 }]);
    expect(await records.removeAll(alice)).toBe(2);
    expect(provider.released).toEqual(['alice']);
    expect(await records.list(bob, 'Observation')).toHaveLength(1);
  });

  it('backup() goes through the provider and reports its file; restore() is staged, not live', async () => {
    const b = await records.backup({ destination: '/dest', key: 'k' });
    expect(b.manager).toBe('records');
    expect(b.files).toEqual(['/dest/fake.db']);
    expect(provider.backups).toEqual([{ destination: '/dest', key: 'k' }]);
    await expect(records.restore({ manager: 'backups', takenAt: 'now' }, { key: 'k' })).rejects.toMatchObject({ status: 400 });
    await records.restore({ manager: 'backups', takenAt: 'now', files: ['/dest/fake.db'] }, { key: 'travel-key' });
    expect(provider.staged).toEqual([{ backupFile: '/dest/fake.db', backupKey: 'travel-key' }]);
    expect(await records.integrityOk()).toBe(true);
  });

  it('favourites go through the same door: owner-scoped, Practitioner only, idempotent, gone with the account', async () => {
    expect(favorites.initialized).toBe(true);
    const fav = { source_id: 'source-1', resource_type: 'Practitioner', resource_id: 'dr-a' };
    expect(await records.addFavorite(alice, fav)).toEqual(fav);
    await records.addFavorite(alice, fav);
    await records.addFavorite(bob, { ...fav, resource_id: 'dr-b' });
    expect(await records.favorites(alice, 'Practitioner')).toEqual([fav]);
    expect(await records.favorites(bob, 'Practitioner')).toEqual([{ ...fav, resource_id: 'dr-b' }]);
    await expect(records.favorites(alice, 'Patient')).rejects.toMatchObject({ status: 400, message: 'only Practitioner resources are supported' });
    await expect(records.addFavorite(alice, { ...fav, resource_type: 'Patient' })).rejects.toMatchObject({ status: 400 });
    await expect(records.addFavorite(alice, { ...fav, resource_id: '' })).rejects.toMatchObject({ status: 400, message: 'invalid request payload' });
    await expect(records.favorites(ApiContext.anonymous(engine), 'Practitioner')).rejects.toMatchObject({ status: 401 });
    expect(await records.removeFavorite(bob, fav)).toBe(false);
    expect(await records.removeFavorite(alice, fav)).toBe(true);
    await records.addFavorite(alice, fav);
    await records.removeAll(alice);
    expect(await records.favorites(alice, 'Practitioner')).toEqual([]);
    expect(await records.favorites(bob, 'Practitioner')).toHaveLength(1);
    const bare = new RecordsManager(new Engine(), new FakeRecordsProvider());
    await expect(bare.favorites(alice, 'Practitioner')).rejects.toMatchObject({ status: 501 });
  });
});
