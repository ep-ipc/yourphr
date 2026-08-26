/** An in-memory favourites provider for the Records spec. */
import { BaseFavoritesProvider, type Favorite } from '../BaseFavoritesProvider.js';

export class FakeFavoritesProvider extends BaseFavoritesProvider {
  rows: (Favorite & { owner: string; at: string })[] = [];
  initialized = false;
  async initialize(): Promise<void> { this.initialized = true; }
  private same(a: Favorite, b: Favorite): boolean { return a.source_id === b.source_id && a.resource_type === b.resource_type && a.resource_id === b.resource_id; }
  async list(owner: string, resourceType: string): Promise<Favorite[]> {
    return this.rows.filter((r) => r.owner === owner && r.resource_type === resourceType).map(({ source_id, resource_type, resource_id }) => ({ source_id, resource_type, resource_id }));
  }
  async add(owner: string, fav: Favorite, at: Date): Promise<void> {
    if (!this.rows.some((r) => r.owner === owner && this.same(r, fav))) this.rows.push({ owner, ...fav, at: at.toISOString() });
  }
  async remove(owner: string, fav: Favorite): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.owner === owner && this.same(r, fav)));
    return this.rows.length < before;
  }
  async removeAll(owner: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.owner !== owner);
    return before - this.rows.length;
  }
}
