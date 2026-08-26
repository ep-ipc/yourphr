/** An in-memory catalog provider for the manager specs; the secret is held beside the entry, never on it. */
import { BaseCatalogProvider } from '../BaseCatalogProvider.js';
export class FakeCatalogProvider extends BaseCatalogProvider {
    rows = new Map();
    initialized = false;
    nextId = 1;
    async initialize() { this.initialized = true; }
    entry(id, f) {
        const { clientSecret, ...rest } = f;
        return { id, ...rest, hasClientSecret: clientSecret !== '' };
    }
    async create(fields) {
        if ([...this.rows.values()].some((r) => r.display === fields.display))
            throw new Error('UNIQUE constraint failed: provider_catalog.display');
        const id = this.nextId++;
        this.rows.set(id, { ...fields });
        return this.entry(id, fields);
    }
    async update(id, fields) {
        if (!this.rows.has(id))
            return undefined;
        this.rows.set(id, { ...fields });
        return this.entry(id, fields);
    }
    async remove(id) { return this.rows.delete(id); }
    async byId(id) { const r = this.rows.get(id); return r ? this.entry(id, r) : undefined; }
    async byDisplay(display) {
        for (const [id, r] of this.rows)
            if (r.display === display)
                return this.entry(id, r);
        return undefined;
    }
    async list() { return [...this.rows].map(([id, r]) => this.entry(id, r)).sort((a, b) => a.display.localeCompare(b.display)); }
    async clientSecretFor(id) { return this.rows.get(id)?.clientSecret ?? ''; }
}
//# sourceMappingURL=FakeCatalogProvider.js.map