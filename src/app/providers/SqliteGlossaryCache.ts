/**
 * The glossary cache in the app database (yourphr#640).
 *
 * A cache, not records: every row is re-fetchable, nothing here is PHI, and losing it costs one
 * lookup per code. It exists because MedlinePlus is rate-limited to 100 requests a minute and a
 * lab page can carry dozens of codes — without it, opening the same page twice is two dozen
 * outbound requests.
 *
 * Keyed on (code, code_system) exactly as Go's `glossaries` table is, so its rows can be carried
 * across by the migration tool rather than re-fetched.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { BaseGlossaryCacheProvider, type GlossaryEntry } from './BaseGlossaryProvider.js';

interface Row {
  code: string;
  code_system: string;
  title: string;
  description: string;
  url: string;
  publisher: string;
  updated_at: string;
}

export class SqliteGlossaryCache extends BaseGlossaryCacheProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
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

  override get(code: string, codeSystem: string): GlossaryEntry | undefined {
    const row = this.db.prepare('SELECT * FROM glossaries WHERE code = ? AND code_system = ?').get(code, codeSystem) as Row | undefined;
    if (!row) return undefined;
    return { title: row.title, description: row.description, url: row.url, publisher: row.publisher, updatedAt: row.updated_at };
  }

  override put(code: string, codeSystem: string, entry: GlossaryEntry, now = new Date()): void {
    this.db.prepare(`INSERT INTO glossaries (code, code_system, title, description, url, publisher, updated_at, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code, code_system) DO UPDATE SET
        title = excluded.title, description = excluded.description, url = excluded.url,
        publisher = excluded.publisher, updated_at = excluded.updated_at, cached_at = excluded.cached_at`)
      .run(code, codeSystem, entry.title, entry.description, entry.url, entry.publisher, entry.updatedAt, now.toISOString());
  }

  /** How many codes this instance has ever explained — the number yourphr#606 turned on. */
  override count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM glossaries').get() as { n: number }).n;
  }
}
