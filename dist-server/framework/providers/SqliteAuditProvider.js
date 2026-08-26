import { BaseAuditProvider } from './BaseAuditProvider.js';
export class SqliteAuditProvider extends BaseAuditProvider {
    db;
    constructor(db) {
        super();
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS access_events (
      user_id TEXT NOT NULL,
      actor_username TEXT NOT NULL,
      category TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (user_id, actor_username, category, day)
    )`);
    }
    async initialize() { }
    async healthCheck() {
        try {
            return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'access_events'").get() !== undefined;
        }
        catch {
            return false;
        }
    }
    async record(owner, actor, category, at) {
        const iso = at.toISOString();
        this.db
            .prepare(`INSERT INTO access_events (user_id, actor_username, category, day, count, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(user_id, actor_username, category, day) DO UPDATE SET count = count + 1, last_at = excluded.last_at`)
            .run(owner, actor, category, iso.slice(0, 10), iso, iso);
    }
    async importEvent(owner, e) {
        return this.db
            .prepare('INSERT OR IGNORE INTO access_events (user_id, actor_username, category, day, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(owner, e.actor_username, e.category, e.day, e.count, e.first_at, e.last_at).changes > 0;
    }
    async list(owner) {
        return this.db
            .prepare('SELECT actor_username, category, day, count, first_at, last_at FROM access_events WHERE user_id = ? ORDER BY day DESC, last_at DESC, category')
            .all(owner);
    }
    async removeForOwner(owner) {
        this.db.prepare('DELETE FROM access_events WHERE user_id = ?').run(owner);
    }
}
//# sourceMappingURL=SqliteAuditProvider.js.map