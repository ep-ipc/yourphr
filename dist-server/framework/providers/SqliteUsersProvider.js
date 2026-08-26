import { BaseUsersProvider, normaliseRole } from './BaseUsersProvider.js';
/**
 * The table as the provider creates it on a fresh database. The app migration that added `role`
 * (src/app.ts, 20260822090000) carries a frozen copy of the pre-role shape — keep this one current
 * and that one untouched.
 */
export const AUTH_USERS_SCHEMA = `CREATE TABLE IF NOT EXISTS auth_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  token_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
)`;
export class SqliteUsersProvider extends BaseUsersProvider {
    db;
    constructor(db) {
        super();
        this.db = db;
        db.exec(AUTH_USERS_SCHEMA);
        db.exec(`CREATE TABLE IF NOT EXISTS legal_consent (
      user_id TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL DEFAULT ''
    )`);
    }
    async initialize() { }
    toRecord(r) {
        return { username: r.username, passwordHash: r.password_hash, tokenGeneration: r.token_generation, role: normaliseRole(r.role), createdAt: r.created_at };
    }
    async create(record) {
        this.db.prepare('INSERT INTO auth_users (username, password_hash, token_generation, created_at, role) VALUES (?, ?, ?, ?, ?)')
            .run(record.username, record.passwordHash, record.tokenGeneration, record.createdAt ?? new Date().toISOString(), record.role);
    }
    async get(username) {
        const r = this.db.prepare('SELECT * FROM auth_users WHERE username = ?').get(username);
        return r ? this.toRecord(r) : undefined;
    }
    async list() {
        return this.db.prepare('SELECT * FROM auth_users ORDER BY created_at, username').all().map((r) => this.toRecord(r));
    }
    async count() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n;
    }
    async setPasswordHash(username, hash, bumpGeneration) {
        const sql = bumpGeneration
            ? 'UPDATE auth_users SET password_hash = ?, token_generation = token_generation + 1 WHERE username = ?'
            : 'UPDATE auth_users SET password_hash = ? WHERE username = ?';
        return this.db.prepare(sql).run(hash, username).changes === 1;
    }
    async bumpGeneration(username) {
        this.db.prepare('UPDATE auth_users SET token_generation = token_generation + 1 WHERE username = ?').run(username);
    }
    async delete(username) {
        return this.db.prepare('DELETE FROM auth_users WHERE username = ?').run(username).changes > 0;
    }
    async consentAcceptedAt(username) {
        const row = this.db.prepare('SELECT accepted_at FROM legal_consent WHERE user_id = ?').get(username);
        return (row?.accepted_at ?? '').trim();
    }
    async setConsentAcceptedAt(username, acceptedAt) {
        this.db
            .prepare('INSERT INTO legal_consent (user_id, accepted_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET accepted_at = excluded.accepted_at')
            .run(username, acceptedAt);
    }
}
//# sourceMappingURL=SqliteUsersProvider.js.map