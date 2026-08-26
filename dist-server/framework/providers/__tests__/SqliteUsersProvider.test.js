import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteUsersProvider } from '../SqliteUsersProvider.js';
describe('SqliteUsersProvider — the accounts table', () => {
    it('creates, reads, lists, counts, sets hashes with or without a generation bump, deletes', async () => {
        const p = new SqliteUsersProvider(new Database(':memory:'));
        await p.initialize();
        await p.create({ username: 'alice', passwordHash: 'h1', tokenGeneration: 0, role: 'user' });
        await p.create({ username: 'ops', passwordHash: 'h2', tokenGeneration: 2, role: 'admin', createdAt: '2026-01-01T00:00:00Z' });
        expect(await p.count()).toBe(2);
        expect((await p.get('alice'))?.role).toBe('user');
        expect((await p.list()).map((u) => u.username).sort()).toEqual(['alice', 'ops']);
        expect(await p.setPasswordHash('alice', 'h3', false)).toBe(true);
        expect((await p.get('alice'))?.tokenGeneration).toBe(0);
        expect(await p.setPasswordHash('alice', 'h4', true)).toBe(true);
        expect((await p.get('alice'))?.tokenGeneration).toBe(1);
        await p.bumpGeneration('alice');
        expect((await p.get('alice'))?.tokenGeneration).toBe(2);
        expect(await p.setPasswordHash('nobody', 'x', true)).toBe(false);
        expect(await p.delete('alice')).toBe(true);
        expect(await p.delete('alice')).toBe(false);
        await expect(p.create({ username: 'ops', passwordHash: 'x', tokenGeneration: 0, role: 'user' })).rejects.toThrow(/UNIQUE/);
    });
    it('never reads an unknown role as a privilege', async () => {
        const db = new Database(':memory:');
        const p = new SqliteUsersProvider(db);
        db.prepare("INSERT INTO auth_users (username, password_hash, token_generation, created_at, role) VALUES ('x', 'h', 0, 'now', 'ADMIN')").run();
        expect((await p.get('x'))?.role).toBe('user');
    });
});
//# sourceMappingURL=SqliteUsersProvider.test.js.map