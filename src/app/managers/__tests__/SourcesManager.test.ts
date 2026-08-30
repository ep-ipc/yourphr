import { beforeEach, describe, expect, it } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { Engine } from '../../../framework/Engine.js';
import { ApiContext } from '../../../framework/ApiContext.js';
import { RecordsManager } from '../RecordsManager.js';
import { JobsManager } from '../../../framework/managers/JobsManager.js';
import { SourcesManager, isDisconnected, sourceShape, type NewSource } from '../SourcesManager.js';
import { EventBus, type SourceEvent } from '../../../events/index.js';
import { FakeRecordsProvider } from '../../providers/__tests__/FakeRecordsProvider.js';
import { FakeJobsProvider } from '../../../framework/providers/__tests__/FakeJobsProvider.js';
import { FakeSourcesProvider } from '../../providers/__tests__/FakeSourcesProvider.js';
import { BaseSourceClientProvider, NullSourceClientProvider, type AuthorizationResult, type AuthorizationStart, type FetchReport, type RefreshedTokens } from '../../providers/BaseSourceClientProvider.js';
import type { ConnectedSource } from '../../providers/BaseSourcesProvider.js';
import type { RecordsWriter } from '../../providers/BaseRecordsProvider.js';
import { ConfigurationManager } from '../../../framework/ConfigurationManager.js';
import { PolicyManager } from '../../../framework/managers/PolicyManager.js';
import { FakeConfigProvider } from '../../../framework/providers/__tests__/FakeConfigProvider.js';

/** A scripted source client: refresh rotates tokens (or fails), fetch writes N records (or fails). */
class ScriptedClient extends BaseSourceClientProvider {
  readonly name = 'scripted';
  refreshes = 0;
  fetches: string[] = [];
  failRefresh = false;
  failFetch = false;
  perType = 2;
  async beginAuthorization(): Promise<AuthorizationStart> { throw new Error('not in this spec'); }
  async completeAuthorization(): Promise<AuthorizationResult> { throw new Error('not in this spec'); }
  async refresh(source: ConnectedSource, now: number): Promise<RefreshedTokens> {
    this.refreshes++;
    if (this.failRefresh) throw new Error('token endpoint said no');
    return { accessToken: `fresh-${this.refreshes}`, refreshToken: `rotated-${this.refreshes}`, expiresAt: now + 3600, tokenUrl: source.tokenUrl || 'https://idp.example.org/token' };
  }
  async fetchPages(source: ConnectedSource, resourceType: string, accessToken: string, writer: RecordsWriter): Promise<FetchReport> {
    this.fetches.push(`${source.id}:${resourceType}:${accessToken}`);
    if (this.failFetch) throw new Error('FHIR HTTP 500');
    let created = 0;
    let updated = 0;
    for (let i = 1; i <= this.perType; i++) {
      const r = await writer.upsert({ resourceType, id: `${resourceType.toLowerCase()}-${source.patient}-${i}`, code: { text: `synthetic ${resourceType}` } } as Resource);
      if (r === 'created') created++;
      else updated++;
    }
    return { received: this.perType, created, updated };
  }
}

const NOW = 1_000_000;
const newSource = (userId: string, over: Partial<NewSource> = {}): NewSource => ({
  userId, display: `${userId}'s clinic`, fhirBaseUrl: 'https://fhir.example.org/r4', tokenUrl: 'https://fhir.example.org/token', clientId: 'cid',
  patient: `p-${userId}`, resourceTypes: ['Condition', 'Observation'], accessToken: 'tok', refreshToken: 'ref', expiresAt: NOW + 100_000,
  platformType: 'ehr', environment: 'sandbox', ...over,
});

let engine: Engine;
let sourcesProvider: FakeSourcesProvider;
let jobsProvider: FakeJobsProvider;
let recordsProvider: FakeRecordsProvider;
let client: ScriptedClient;
let events: EventBus;
let sources: SourcesManager;
let records: RecordsManager;
let jobs: JobsManager;
let lines: string[];
let alice: ApiContext;
let bob: ApiContext;
let admin: ApiContext;
let migration: ApiContext;

beforeEach(async () => {
  engine = new Engine();
  sourcesProvider = new FakeSourcesProvider();
  jobsProvider = new FakeJobsProvider((id) => sourcesProvider.rows.get(id)?.userId);
  recordsProvider = new FakeRecordsProvider();
  client = new ScriptedClient();
  events = new EventBus();
  lines = [];
  records = new RecordsManager(engine, recordsProvider);
  jobs = new JobsManager(engine, jobsProvider);
  sources = new SourcesManager(engine, sourcesProvider, client, { maxPages: 5, events, log: (l) => lines.push(l) });
  engine.register('configuration', new ConfigurationManager(engine, new FakeConfigProvider(), { env: {} }))
    .register('policy', new PolicyManager(engine));
  engine.register('records', records).register('jobs', jobs).register('sources', sources);
  await engine.initialize();
  records.sourceDisplay = (id) => sources.displayOf(id);
  alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  bob = ApiContext.from({ username: 'bob', role: 'user' }, engine);
  admin = ApiContext.from({ username: 'root', role: 'admin' }, engine);
  migration = ApiContext.system('migration', 'migration', engine);
});

describe('SourcesManager — ownership is the seam', () => {
  it('boots after records and jobs, initialises its provider, and names the client it was bound to', () => {
    expect(engine.registered).toEqual(['configuration', 'policy', 'records', 'jobs', 'sources']);
    expect(sourcesProvider.initialized).toBe(true);
    expect(lines).toContain("sources: client provider 'scripted'");
  });

  it('a member connects a source for themselves only; a system principal acts for the account it is for', async () => {
    await expect(sources.add(alice, newSource('bob'))).rejects.toMatchObject({ status: 403 });
    const mine = await sources.add(alice, newSource('alice'));
    const seeded = await sources.add(ApiContext.system('seed', 'bob', engine), newSource('bob'));
    expect(mine.id).toBe(1);
    expect(seeded.userId).toBe('bob');
    await expect(sources.add(ApiContext.anonymous(engine), newSource('alice'))).rejects.toMatchObject({ status: 401 });
  });

  it('list and get answer only for the caller; a malformed or foreign id is simply not found', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.add(bob, newSource('bob'));
    expect((await sources.list(alice)).map((s) => s.userId)).toEqual(['alice']);
    expect(await sources.get(alice, 'source-1')).toMatchObject({ userId: 'alice' });
    expect(await sources.get(bob, 'source-1')).toBeUndefined();
    expect(await sources.get(alice, 'nope')).toBeUndefined();
    expect(await sources.owned(alice, 2)).toBeUndefined();
    expect(await sources.displayOf('source-2')).toBe("bob's clinic");
    expect(await sources.displayOf('source-99')).toBe('');
    expect(await sources.count()).toBe(2);
  });

  it('shapes a source as Go\'s SourceCredential: public id, redacted secrets, absent unknowns, latest job when there is one', async () => {
    const s = await sources.add(alice, newSource('alice', { platformType: '', environment: '' }));
    const shaped = sourceShape(s, undefined);
    expect(shaped).toMatchObject({ id: 'source-1', access_token: '[REDACTED]', refresh_token: '[REDACTED]', api_endpoint_base_url: 'https://fhir.example.org/r4' });
    expect(shaped).not.toHaveProperty('platform_type');
    expect(shaped).not.toHaveProperty('updated_at');
    expect(shaped).not.toHaveProperty('latest_background_job');
    await sources.syncNow(alice, 'source-1', NOW);
    const [listed] = await sources.listShaped(alice);
    expect(listed).toMatchObject({ updated_at: new Date(NOW * 1000).toISOString(), latest_background_job: { job_status: 'STATUS_DONE' } });
    expect(await sources.getShaped(bob, 'source-1')).toBeUndefined();
    const summary = await sources.summary(alice, 'source-1');
    expect(summary).toMatchObject({ source: { id: 'source-1' }, resource_type_counts: expect.arrayContaining([expect.objectContaining({ resource_type: 'Condition', count: 2 })]) });
  });
});

describe('SourcesManager — the pass (what src/worker was)', () => {
  it('refreshes an expiring token BEFORE the sync, persists the rotation, and accounts for it exactly', async () => {
    const s = await sources.add(alice, newSource('alice', { accessToken: 'stale', expiresAt: NOW - 10 }));
    const report = await sources.pass(NOW);
    expect(report).toEqual({ refreshAttempted: 1, refreshed: 1, synced: 1, failed: 0 });
    expect(client.fetches).toEqual(['1:Condition:fresh-1', '1:Observation:fresh-1']);
    expect(await sources.owned(alice, s.id)).toMatchObject({ accessToken: 'fresh-1', refreshToken: 'rotated-1', expiresAt: NOW + 3600, lastSyncAt: NOW });
    expect(lines).toContain('token-refresh: attempted 1, refreshed 1');
    expect(await records.countsByType(alice)).toEqual(expect.arrayContaining([{ resource_type: 'Condition', count: 2 }, { resource_type: 'Observation', count: 2 }]));
  });

  it('persists a discovered token endpoint once (a migrated source arrives without one)', async () => {
    await sources.add(alice, newSource('alice', { tokenUrl: '', expiresAt: 0 }));
    await sources.pass(NOW);
    expect((await sources.owned(alice, 1))?.tokenUrl).toBe('https://idp.example.org/token');
  });

  it('leaves a fresh token alone and a resync creates nothing new', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.pass(NOW);
    const second = await sources.pass(NOW + 10);
    expect(second).toEqual({ refreshAttempted: 0, refreshed: 0, synced: 1, failed: 0 });
    expect(client.refreshes).toBe(0);
    expect((await jobs.latest(1))).toMatchObject({ outcome: 'success', received: 4, created: 0, updated: 4 });
  });

  it('expired with no refresh token: says so ONCE, records one failure job, and pauses the sync instead of hammering the provider (yourphr#706)', async () => {
    const s = await sources.add(alice, newSource('alice', { refreshToken: '', expiresAt: NOW - 10 }));
    const first = await sources.pass(NOW);
    expect(first).toEqual({ refreshAttempted: 0, refreshed: 0, synced: 0, failed: 0 });
    expect(client.fetches).toEqual([]); // no doomed fetch with a token known to be dead
    expect(lines.filter((l) => l.includes('reconnect the source')).length).toBe(1);
    expect(await jobs.latest(s.id)).toMatchObject({ outcome: 'failure', error: expect.stringContaining('reconnect the source') });

    // Every later cycle is silent — no new log line, no new job.
    await sources.pass(NOW + 900);
    await sources.pass(NOW + 1800);
    expect(lines.filter((l) => l.includes('reconnect the source')).length).toBe(1);
    expect((await jobsProvider.all()).filter((j) => j.sourceId === s.id).length).toBe(1);

    // A reconnect (new tokens) lifts the pause and the source syncs again.
    await sourcesProvider.updateTokens(s.id, 'fresh', 'rotated', NOW + 7200);
    const after = await sources.pass(NOW + 2700);
    expect(after).toMatchObject({ synced: 1, failed: 0 });
    expect(client.fetches.length).toBeGreaterThan(0);
  });

  it('a user-triggered sync still attempts an expired unrefreshable source and reports honestly', async () => {
    await sources.add(alice, newSource('alice', { refreshToken: '', accessToken: 'dead', expiresAt: NOW - 10 }));
    await sources.pass(NOW); // paused for the worker
    const before = client.fetches.length;
    await sources.syncNow(alice, 'source-1', NOW);
    expect(client.fetches.length).toBeGreaterThan(before); // syncNow is not gated by the pause
  });

  it('a failed refresh is logged, not fatal: the sync runs on the old token', async () => {
    client.failRefresh = true;
    await sources.add(alice, newSource('alice', { accessToken: 'old', expiresAt: NOW - 10 }));
    const report = await sources.pass(NOW);
    expect(report).toMatchObject({ refreshAttempted: 1, refreshed: 0, synced: 1 });
    expect(client.fetches[0]).toBe('1:Condition:old');
    expect(lines.some((l) => l.includes('token endpoint said no'))).toBe(true);
  });

  it('skips a disconnected source entirely', async () => {
    const s = await sources.add(alice, newSource('alice', { accessToken: '', refreshToken: '' }));
    expect(isDisconnected(s)).toBe(true);
    expect(await sources.pass(NOW)).toEqual({ refreshAttempted: 0, refreshed: 0, synced: 0, failed: 0 });
    expect(client.fetches).toEqual([]);
  });

  it('one source failing never costs the other its sync, and the failure is recorded with its error', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.add(bob, newSource('bob'));
    client.failFetch = true;
    expect(await sources.pass(NOW)).toMatchObject({ synced: 0, failed: 2 });
    client.failFetch = false;
    expect(await sources.pass(NOW + 1)).toMatchObject({ synced: 2, failed: 0 });
    expect((await jobs.history(2)).map((j) => [j.outcome, j.error])).toEqual([['failure', 'FHIR HTTP 500'], ['success', '']]);
  });

  it('the worker acts for each owner: records land under the source\'s owner, never anyone else', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.add(bob, newSource('bob', { resourceTypes: ['Condition'] }));
    await sources.pass(NOW);
    expect((await records.countsByType(alice)).reduce((n, c) => n + c.count, 0)).toBe(4);
    expect((await records.countsByType(bob)).reduce((n, c) => n + c.count, 0)).toBe(2);
  });
});

describe('SourcesManager — sync now, disconnect, remove, export', () => {
  const seen: SourceEvent[] = [];
  beforeEach(() => { seen.length = 0; events.subscribe('alice', (e) => seen.push(e)); });

  it('sync now answers as Go does — the source with its fresh job, and the rows touched — framed by the events the page follows', async () => {
    await sources.add(alice, newSource('alice'));
    const result = await sources.syncNow(alice, 'source-1', NOW);
    expect(result).toMatchObject({ data: 4, source: { id: 'source-1', latest_background_job: { job_status: 'STATUS_DONE' } } });
    expect(seen.map((e) => e.event_type)).toEqual(['source_sync', 'source_complete']);
    expect(await sources.syncNow(bob, 'source-1', NOW)).toBeUndefined();
  });

  it('a failed sync now is an error the route can say, and the completion event still fires', async () => {
    await sources.add(alice, newSource('alice'));
    client.failFetch = true;
    await expect(sources.syncNow(alice, 'source-1', NOW)).rejects.toMatchObject({ status: 502, message: 'FHIR HTTP 500' });
    expect(seen.map((e) => e.event_type)).toEqual(['source_sync', 'source_complete']);
  });

  it('disconnect drops the tokens and keeps the records; the worker then skips it', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.pass(NOW);
    expect(await sources.disconnect(bob, 'source-1')).toBe(false);
    expect(await sources.disconnect(alice, 'source-1')).toBe(true);
    expect(await sources.owned(alice, 1)).toMatchObject({ accessToken: '', refreshToken: '', expiresAt: 0 });
    expect((await records.countsByType(alice)).length).toBe(2);
    expect(await sources.pass(NOW + 1)).toMatchObject({ synced: 0, failed: 0 });
  });

  it('disconnectWhere applies a rule to the caller\'s sources only and counts what it touched', async () => {
    await sources.add(alice, newSource('alice', { display: 'Medicare' }));
    await sources.add(alice, newSource('alice', { display: 'Clinic' }));
    await sources.add(bob, newSource('bob', { display: 'Medicare' }));
    expect(await sources.disconnectWhere(alice, (s) => s.display === 'Medicare')).toBe(1);
    expect((await sources.owned(bob, 3))?.accessToken).toBe('tok');
  });

  it('disconnectConsentRequired disconnects the Medicare family and nothing else — Go\'s consent rule, at the sources door (yourphr#619)', async () => {
    await sources.add(alice, newSource('alice', { display: 'Medicare Blue Button', fhirBaseUrl: 'https://sandbox.bluebutton.cms.gov/v2/fhir' }));
    await sources.add(alice, newSource('alice', { display: 'County Clinic' }));
    await sources.add(bob, newSource('bob', { display: 'Medicare Blue Button', fhirBaseUrl: 'https://sandbox.bluebutton.cms.gov/v2/fhir' }));
    expect(await sources.disconnectConsentRequired(alice)).toBe(1);
    expect((await sources.owned(alice, 1))?.accessToken).toBe('');
    expect((await sources.owned(alice, 2))?.accessToken).toBe('tok');
    expect((await sources.owned(bob, 3))?.accessToken).toBe('tok'); // another account's consent is not this caller's to revoke
    expect(await sources.disconnectConsentRequired(alice)).toBe(0); // already disconnected: nothing left to touch
  });

  it('remove takes the records through the Records door, then the job history, then the source', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.pass(NOW);
    expect(await sources.remove(bob, 'source-1')).toBeUndefined();
    expect(await sources.remove(alice, 'source-1')).toBe(4);
    expect(await sources.count()).toBe(0);
    expect(await jobs.history(1)).toEqual([]);
    expect(await records.countsByType(alice)).toEqual([]);
  });

  it('remove-data keeps the source; removeAll takes every source the caller owns and nobody else\'s', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.add(alice, newSource('alice', { patient: 'p2' }));
    await sources.add(bob, newSource('bob'));
    await sources.pass(NOW);
    expect(await sources.removeData(alice, 'source-1')).toBe(4);
    expect(await sources.count()).toBe(3);
    expect(await sources.removeAll(alice)).toBe(2);
    expect((await sources.list(bob)).length).toBe(1);
  });

  it('exports the source\'s records as a bundle under a slugged, dated filename', async () => {
    await sources.add(alice, newSource('alice', { display: '  Fake Regional Health!! ' }));
    await sources.pass(NOW);
    const exported = await sources.exportBundle(alice, 'source-1');
    expect(exported?.filename).toMatch(/^yourphr-fake-regional-health-\d{8}\.json$/);
    expect(exported?.bundle).toMatchObject({ resourceType: 'Bundle', type: 'collection', total: 4 });
    expect(await sources.exportBundle(bob, 'source-1')).toBeUndefined();
  });

  it('a dynamic client rides with its source and is the owner\'s alone', async () => {
    await sources.add(alice, newSource('alice'));
    const dyn = { clientId: 'dyn-1', clientSecret: '', registrationAccessToken: 'rat', registrationClientUri: 'https://idp.example.org/reg/1' };
    await expect(sources.saveDynamicClient(bob, 1, dyn)).rejects.toMatchObject({ status: 404 });
    await sources.saveDynamicClient(alice, 1, dyn);
    expect(await sources.dynamicClientFor(alice, 1)).toEqual(dyn);
    expect(await sources.dynamicClientFor(bob, 1)).toBeUndefined();
  });
});

describe('SourcesManager — the operator and the migration tool', () => {
  it('admin metrics are for admins, keyed by outcome|platform|environment, newest jobs first', async () => {
    await sources.add(alice, newSource('alice'));
    await sources.add(bob, newSource('bob', { platformType: '', environment: '' }));
    await sources.pass(NOW);
    client.failFetch = true;
    await sources.pass(NOW + 5);
    await expect(sources.adminMetrics(alice)).rejects.toMatchObject({ status: 403 });
    const metrics = await sources.adminMetrics(admin);
    expect(metrics).toMatchObject({ scrape_enabled: false, process: { jobs_total: { 'success|ehr|sandbox': 1, 'success|unknown|unknown': 1, 'failed|ehr|sandbox': 1, 'failed|unknown|unknown': 1 }, duration_count: 4 } });
    const recent = metrics['recent_jobs'] as { id: string; job_status: string }[];
    expect(recent.map((j) => j.id)).toEqual(['4', '3', '2', '1']);
    expect(recent[0]).toMatchObject({ job_status: 'STATUS_FAILED', summary: { error_message: 'FHIR HTTP 500' } });
  });

  it('legacy import is the migration principal\'s alone, one-way, keyed by the legacy id, reporting what needs a reconnect', async () => {
    const legacy = [
      { ...newSource('jim', { display: 'Epic', refreshToken: 'go-ref', expiresAt: 100 }), legacyId: 'src-1' },
      { ...newSource('jim', { display: 'No Refresh', patient: 'p-2', refreshToken: '' }), legacyId: 'src-4' },
    ];
    await expect(sources.importLegacy(alice, legacy)).rejects.toMatchObject({ status: 403 });
    const report = await sources.importLegacy(migration, legacy);
    expect(report).toEqual({ imported: ['jim:Epic', 'jim:No Refresh'], skippedExisting: [], needsReconnect: ['jim:No Refresh'], idMap: { 'src-1': 1, 'src-4': 2 } });
    const jim = ApiContext.from({ username: 'jim', role: 'user' }, engine);
    expect(await sources.owned(jim, 1)).toMatchObject({ tokenUrl: '', accessToken: 'tok', refreshToken: 'go-ref', expiresAt: 100, resourceTypes: ['Condition', 'Observation'] });
    const again = await sources.importLegacy(migration, legacy);
    expect(again).toMatchObject({ imported: [], skippedExisting: ['jim:Epic', 'jim:No Refresh'], idMap: { 'src-1': 1, 'src-4': 2 } });
    expect(await sources.count()).toBe(2);
  });

  it('the Null client is the inert default: nothing fetched, and the job says why', async () => {
    const quiet = new Engine();
    const sp = new FakeSourcesProvider();
    const jp = new FakeJobsProvider((id) => sp.rows.get(id)?.userId);
    quiet.register('records', new RecordsManager(quiet, new FakeRecordsProvider())).register('jobs', new JobsManager(quiet, jp))
      .register('sources', new SourcesManager(quiet, sp, new NullSourceClientProvider(), { maxPages: 1 }));
    await quiet.initialize();
    const who = ApiContext.from({ username: 'alice', role: 'user' }, quiet);
    await quiet.managers.sources.add(who, newSource('alice', { expiresAt: NOW - 1 }));
    expect(await quiet.managers.sources.pass(NOW)).toMatchObject({ refreshAttempted: 1, refreshed: 0, synced: 0, failed: 1 });
    expect((await quiet.managers.jobs.latest(1))?.error).toContain('no source client is configured');
  });

  it('backup and restore are no-ops that say so — the app database carries the rows', async () => {
    expect(await sources.backup()).toMatchObject({ manager: 'sources' });
    expect(await jobs.backup()).toMatchObject({ manager: 'jobs' });
    await expect(sources.restore()).resolves.toBeUndefined();
    await expect(jobs.restore()).resolves.toBeUndefined();
  });
});
