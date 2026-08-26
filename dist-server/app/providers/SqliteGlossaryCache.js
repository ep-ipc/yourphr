import { BaseGlossaryCacheProvider } from './BaseGlossaryProvider.js';
export class SqliteGlossaryCache extends BaseGlossaryCacheProvider {
    db;
    constructor(db) {
        super();
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS glossaries (
      code TEXT NOT NULL,
      code_system TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      publisher TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      cached_at TEXT NOT NULL,
      PRIMARY KEY (code, code_system)
    )`);
    }
    get(code, codeSystem) {
        const row = this.db.prepare('SELECT * FROM glossaries WHERE code = ? AND code_system = ?').get(code, codeSystem);
        if (!row)
            return undefined;
        return { title: row.title, description: row.description, url: row.url, publisher: row.publisher, updatedAt: row.updated_at };
    }
    put(code, codeSystem, entry, now = new Date()) {
        this.db.prepare(`INSERT INTO glossaries (code, code_system, title, description, url, publisher, updated_at, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code, code_system) DO UPDATE SET
        title = excluded.title, description = excluded.description, url = excluded.url,
        publisher = excluded.publisher, updated_at = excluded.updated_at, cached_at = excluded.cached_at`)
            .run(code, codeSystem, entry.title, entry.description, entry.url, entry.publisher, entry.updatedAt, now.toISOString());
    }
    /** How many codes this instance has ever explained — the number yourphr#606 turned on. */
    count() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM glossaries').get().n;
    }
}
//# sourceMappingURL=SqliteGlossaryCache.js.map