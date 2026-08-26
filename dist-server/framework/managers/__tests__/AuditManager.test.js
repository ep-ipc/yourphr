import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../Engine.js';
import { ApiContext } from '../../ApiContext.js';
import { AuditManager } from '../AuditManager.js';
import { FakeAuditProvider } from '../../providers/__tests__/FakeAuditProvider.js';
let provider;
let engine;
let audit;
let alice;
let bob;
beforeEach(async () => {
    provider = new FakeAuditProvider();
    engine = new Engine();
    audit = new AuditManager(engine, provider);
    engine.register('audit', audit);
    await engine.initialize();
    alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
    bob = ApiContext.from({ username: 'bob', role: 'user' }, engine);
});
describe('AuditManager — the access log, required', () => {
    it('initialises its provider and REFUSES to boot over one that is not healthy — never a silent Null', async () => {
        expect(provider.initialized).toBe(true);
        const sick = new FakeAuditProvider();
        sick.healthy = false;
        const e = new Engine();
        e.register('audit', new AuditManager(e, sick));
        await expect(e.initialize()).rejects.toThrow(/refusing to boot with auditing off/);
    });
    it('records the caller as owner and whoever asked as actor, folded into day buckets', async () => {
        const t = new Date('2026-04-01T10:00:00Z');
        await audit.record(alice, 'Summary', t);
        await audit.record(alice, 'Summary', new Date('2026-04-01T11:00:00Z'));
        await audit.record(ApiContext.system('worker', 'alice', engine), 'Records (FHIR)', t);
        await audit.record(alice, 'Summary', new Date('2026-04-02T09:00:00Z'));
        const log = await audit.list(alice);
        expect(log.map((e) => `${e.day}:${e.actor_username}:${e.category}:${e.count}`)).toEqual(['2026-04-02:alice:Summary:1', '2026-04-01:alice:Summary:2', '2026-04-01:worker:Records (FHIR):1']);
        expect(log[1]).toMatchObject({ first_at: '2026-04-01T10:00:00.000Z', last_at: '2026-04-01T11:00:00.000Z' });
        expect(await audit.list(bob)).toEqual([]);
    });
    it('refuses nobody, an empty category, and a write the sink cannot keep — the read must not complete unlogged', async () => {
        await expect(audit.record(ApiContext.anonymous(engine), 'Summary')).rejects.toMatchObject({ status: 401 });
        await expect(audit.record(alice, '  ')).rejects.toMatchObject({ status: 400 });
        provider.failWrites = true;
        await expect(audit.record(alice, 'Summary')).rejects.toThrow('audit sink unavailable');
        expect(await audit.list(alice)).toEqual([]);
    });
    it('legacy import is the migration principal\'s, for the account it acts for, keeping what is already here', async () => {
        const events = [
            { actor_username: 'jim', category: 'Conditions', day: '2026-04-01', count: 3, first_at: '2026-04-01T08:00:00Z', last_at: '2026-04-01T09:00:00Z' },
            { actor_username: 'jim', category: 'Summary', day: '2026-04-02', count: 1, first_at: '2026-04-02T08:00:00Z', last_at: '2026-04-02T08:00:00Z' },
        ];
        await expect(audit.importLegacy(alice, events)).rejects.toMatchObject({ status: 403 });
        const migration = ApiContext.system('migration', 'jim', engine);
        expect(await audit.importLegacy(migration, events)).toEqual({ imported: 2, skipped: 0 });
        expect(await audit.importLegacy(migration, events)).toEqual({ imported: 0, skipped: 2 });
        expect((await audit.list(ApiContext.from({ username: 'jim', role: 'user' }, engine))).map((e) => e.count)).toEqual([1, 3]);
    });
    it('account deletion removes the caller\'s log and nobody else\'s', async () => {
        await audit.record(alice, 'Summary');
        await audit.record(bob, 'Summary');
        await audit.removeForUser(alice);
        expect(await audit.list(alice)).toEqual([]);
        expect(await audit.list(bob)).toHaveLength(1);
        expect(await audit.backup()).toMatchObject({ manager: 'audit' });
        await expect(audit.restore()).resolves.toBeUndefined();
    });
});
//# sourceMappingURL=AuditManager.test.js.map