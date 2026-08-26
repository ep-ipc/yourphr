/** An in-memory sources provider for the manager specs. */
import { BaseSourcesProvider } from '../BaseSourcesProvider.js';
export class FakeSourcesProvider extends BaseSourcesProvider {
    rows = new Map();
    clients = new Map();
    initialized = false;
    nextId = 1;
    async initialize() { this.initialized = true; }
    async add(source) {
        const row = { ...source, id: this.nextId++, lastSyncAt: 0, platformType: source.platformType ?? '', environment: source.environment ?? '' };
        this.rows.set(row.id, row);
        return { ...row };
    }
    async byId(id) { const r = this.rows.get(id); return r ? { ...r } : undefined; }
    async list() { return [...this.rows.values()].map((r) => ({ ...r })); }
    async count() { return this.rows.size; }
    patch(id, change) { const r = this.rows.get(id); if (r)
        this.rows.set(id, { ...r, ...change }); }
    async clearTokens(id) { this.patch(id, { accessToken: '', refreshToken: '', expiresAt: 0 }); }
    async updateTokenUrl(id, tokenUrl) { this.patch(id, { tokenUrl }); }
    async updateTokens(id, accessToken, refreshToken, expiresAt) { this.patch(id, { accessToken, refreshToken, expiresAt }); }
    async markSynced(id, at) { this.patch(id, { lastSyncAt: at }); }
    async remove(id) { this.rows.delete(id); this.clients.delete(id); }
    async saveDynamicClient(sourceId, client) { this.clients.set(sourceId, client); }
    async dynamicClientFor(sourceId) { return this.clients.get(sourceId); }
}
//# sourceMappingURL=FakeSourcesProvider.js.map