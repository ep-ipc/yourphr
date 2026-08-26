/** The favorites table in the app database (yourphr#616). */
import type Database from 'better-sqlite3-multiple-ciphers';
import { BaseFavoritesProvider, type Favorite } from './BaseFavoritesProvider.js';

export class SqliteFavoritesProvider extends BaseFavoritesProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
    db.exec(`CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_id, resource_type, resource_id)
    )`);
  }

  async initialize(): Promise<void> { /* schema ensured in the constructor */ }

  async list(owner: string, resourceType: string): Promise<Favorite[]> {
    return this.db
      .prepare('SELECT source_id, resource_type, resource_id FROM favorites WHERE user_id = ? AND resource_type = ? ORDER BY created_at, resource_id')
      .all(owner, resourceType) as Favorite[];
  }

  async add(owner: string, fav: Favorite, at: Date): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO favorites (user_id, source_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(owner, fav.source_id, fav.resource_type, fav.resource_id, at.toISOString());
  }

  async remove(owner: string, fav: Favorite): Promise<boolean> {
    return this.db
      .prepare('DELETE FROM favorites WHERE user_id = ? AND source_id = ? AND resource_type = ? AND resource_id = ?')
      .run(owner, fav.source_id, fav.resource_type, fav.resource_id).changes > 0;
  }

  async removeAll(owner: string): Promise<number> {
    return this.db.prepare('DELETE FROM favorites WHERE user_id = ?').run(owner).changes;
  }
}
