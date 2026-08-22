import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteAuditProvider } from '../SqliteAuditProvider.js';

let db: InstanceType<typeof Database>;
let audit: SqliteAuditProvider;

beforeEach(async () => {
  db = new Database(':memory:');
  audit = new SqliteAuditProvider(db);
  await audit.initialize();
});

describe('SqliteAuditProvider — the access_events table', () => {
  it('is healthy over an open database and not over a closed one', async () => {
    expect(await audit.healthCheck()).toBe(true);
    db.close();
    expect(await audit.healthCheck()).toBe(false);
  });

  it('folds accesses into (actor, category, day) buckets and lists newest day first', async () => {
    await audit.record('alice', 'alice', 'Summary', new Date('2026-04-01T10:00:00Z'));
    await audit.record('alice', 'alice', 'Summary', new Date('2026-04-01T12:00:00Z'));
    await audit.record('alice', 'worker', 'Records (FHIR)', new Date('2026-04-01T11:00:00Z'));
    await audit.record('alice', 'alice', 'Summary', new Date('2026-04-02T10:00:00Z'));
    await audit.record('bob', 'bob', 'Summary', new Date('2026-04-02T10:00:00Z'));
    const log = await audit.list('alice');
    expect(log.map((e) => `${e.day}:${e.actor_username}:${e.category}:${e.count}`)).toEqual(['2026-04-02:alice:Summary:1', '2026-04-01:alice:Summary:2', '2026-04-01:worker:Records (FHIR):1']);
    expect(log[1]).toMatchObject({ first_at: '2026-04-01T10:00:00.000Z', last_at: '2026-04-01T12:00:00.000Z' });
  });

  it('imports a bucket once, and removes an owner\'s log only', async () => {
    const e = { actor_username: 'jim', category: 'Conditions', day: '2026-04-01', count: 3, first_at: '2026-04-01T08:00:00Z', last_at: '2026-04-01T09:00:00Z' };
    expect(await audit.importEvent('jim', e)).toBe(true);
    expect(await audit.importEvent('jim', e)).toBe(false);
    await audit.record('pat', 'pat', 'Summary', new Date());
    await audit.removeForOwner('jim');
    expect(await audit.list('jim')).toEqual([]);
    expect(await audit.list('pat')).toHaveLength(1);
  });
});
