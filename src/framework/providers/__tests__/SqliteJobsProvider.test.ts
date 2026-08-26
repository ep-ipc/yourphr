import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteJobsProvider } from '../SqliteJobsProvider.js';
import { SqliteSourcesProvider } from '../../../app/providers/SqliteSourcesProvider.js';

let db: InstanceType<typeof Database>;
let jobs: SqliteJobsProvider;
const job = (sourceId: number, outcome: 'success' | 'failure', error = '') => ({ sourceId, outcome, received: 2, created: 1, updated: 1, error, startedAt: 10, finishedAt: 12 });

beforeEach(async () => {
  db = new Database(':memory:');
  const sources = new SqliteSourcesProvider(db);
  await sources.initialize();
  const row = { display: 'Clinic', fhirBaseUrl: 'https://fhir.example.org/r4', tokenUrl: '', clientId: 'c', patient: 'p', resourceTypes: ['Condition'], accessToken: 't', refreshToken: '', expiresAt: 0 };
  await sources.add({ userId: 'alice', ...row });
  await sources.add({ userId: 'bob', ...row });
  jobs = new SqliteJobsProvider(db);
  await jobs.initialize();
  await jobs.record(job(1, 'success'));
  await jobs.record(job(1, 'failure', 'HTTP 500'));
  await jobs.record(job(2, 'success'));
});

describe('SqliteJobsProvider — the sync_jobs table', () => {
  it('records with a row id; latest is the newest per source; all is oldest first, optionally per source', async () => {
    expect((await jobs.record(job(2, 'failure'))).id).toBe(4);
    expect(await jobs.latest(1)).toMatchObject({ id: 2, outcome: 'failure', error: 'HTTP 500' });
    expect(await jobs.latest(9)).toBeUndefined();
    expect((await jobs.all()).map((j) => j.id)).toEqual([1, 2, 3, 4]);
    expect((await jobs.all(2)).map((j) => j.id)).toEqual([3, 4]);
  });

  it('forUser joins through the source\'s owner, newest first, filtered and paged', async () => {
    expect((await jobs.forUser('alice', { limit: 20, offset: 0 })).map((j) => j.id)).toEqual([2, 1]);
    expect((await jobs.forUser('alice', { limit: 20, offset: 0, outcome: 'success' })).map((j) => j.id)).toEqual([1]);
    expect((await jobs.forUser('alice', { limit: 1, offset: 1 })).map((j) => j.id)).toEqual([1]);
    expect(await jobs.forUser('carol', { limit: 20, offset: 0 })).toEqual([]);
  });

  it('removes a source\'s history and nobody else\'s', async () => {
    await jobs.removeForSource(1);
    expect((await jobs.all()).map((j) => j.id)).toEqual([3]);
  });
});
