/** An in-memory favourites provider for the Records spec. */
import { BaseFavoritesProvider } from '../BaseFavoritesProvider.js';
export class FakeFavoritesProvider extends BaseFavoritesProvider {
    rows = [];
    initialized = false;
    async initialize() { this.initialized = true; }
    same(a, b) { return a.source_id === b.source_id && a.resource_type === b.resource_type && a.resource_id === b.resource_id; }
    async list(owner, resourceType) {
        return this.rows.filter((r) => r.owner === owner && r.resource_type === resourceType).map(({ source_id, resource_type, resource_id }) => ({ source_id, resource_type, resource_id }));
    }
    async add(owner, fav, at) {
        if (!this.rows.some((r) => r.owner === owner && this.same(r, fav)))
            this.rows.push({ owner, ...fav, at: at.toISOString() });
    }
    async remove(owner, fav) {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => !(r.owner === owner && this.same(r, fav)));
        return this.rows.length < before;
    }
    async removeAll(owner) {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => r.owner !== owner);
        return before - this.rows.length;
    }
}
//# sourceMappingURL=FakeFavoritesProvider.js.map