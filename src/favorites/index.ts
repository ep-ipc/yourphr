/**
 * Favourites (yourphr#595): the practitioners a person starred. Go keeps a non-FHIR `favorites`
 * table keyed (user, source, type, id); this is the same table, per user, in the app database.
 * Only Practitioner is accepted — the one kind the UI stars — so a typo cannot star the world.
 */
import type Database from 'better-sqlite3-multiple-ciphers';

export interface Favorite {
  source_id: string;
  resource_type: string;
  resource_id: string;
}

export class FavoriteStore {
  constructor(private readonly db: InstanceType<typeof Database>) {
    db.exec(`CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_id, resource_type, resource_id)
    )`);
  }

  static supports(resourceType: string): boolean {
    return resourceType === 'Practitioner';
  }

  list(userId: string, resourceType: string): Favorite[] {
    return this.db
      .prepare('SELECT source_id, resource_type, resource_id FROM favorites WHERE user_id = ? AND resource_type = ? ORDER BY created_at, resource_id')
      .all(userId, resourceType) as Favorite[];
  }

  add(userId: string, fav: Favorite): void {
    this.db
      .prepare('INSERT OR IGNORE INTO favorites (user_id, source_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, fav.source_id, fav.resource_type, fav.resource_id, new Date().toISOString());
  }

  remove(userId: string, fav: Favorite): boolean {
    return this.db
      .prepare('DELETE FROM favorites WHERE user_id = ? AND source_id = ? AND resource_type = ? AND resource_id = ?')
      .run(userId, fav.source_id, fav.resource_type, fav.resource_id).changes > 0;
  }
}
