import { textFor } from '../record-text.js';
import { BaseRecordsProvider } from '../BaseRecordsProvider.js';
export class FakeRecordsProvider extends BaseRecordsProvider {
    rows = new Map();
    initialized = false;
    closed = false;
    released = [];
    backups = [];
    clock = 0;
    key(userId, type, id) { return `${userId}|${type}|${id}`; }
    tick() { this.clock++; return `2026-01-01T00:00:${String(this.clock).padStart(2, '0')}Z`; }
    mine(userId) { return [...this.rows.values()].filter((r) => r.userId === userId); }
    /** Seed straight into the store — what a test does before asking the manager. */
    seed(userId, sourceId, resource) {
        const at = this.tick();
        this.rows.set(this.key(userId, resource.resourceType, resource.id ?? ''), { userId, resourceType: resource.resourceType, id: resource.id ?? '', sourceId, lastUpdated: at, resource, versions: 1, firstSeen: at });
    }
    async initialize() { this.initialized = true; }
    async close() { this.closed = true; }
    async search(userId, request) {
        const entry = this.mine(userId).filter((r) => r.resourceType === request.resourceType).slice(0, request.count ?? 20).map((r) => ({ resource: r.resource }));
        return { resourceType: 'Bundle', type: 'searchset', total: entry.length, entry };
    }
    async read(userId, resourceType, id) { return this.rows.get(this.key(userId, resourceType, id)); }
    async readById(userId, id) { return this.mine(userId).find((r) => r.id === id); }
    async list(userId, filter = {}) {
        return this.mine(userId).filter((r) => (filter.resourceType === undefined || r.resourceType === filter.resourceType) && (filter.sourceId === undefined || r.sourceId === filter.sourceId));
    }
    async countByType(userId, sourceId) {
        const counts = new Map();
        for (const r of await this.list(userId, sourceId === undefined ? {} : { sourceId }))
            counts.set(r.resourceType, (counts.get(r.resourceType) ?? 0) + 1);
        return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resourceType, count]) => ({ resourceType, count }));
    }
    async typesHeld(userId) { return [...new Set(this.mine(userId).map((r) => r.resourceType))].sort(); }
    async sourceOf(userId, resourceType) { return new Map(this.mine(userId).filter((r) => r.resourceType === resourceType).map((r) => [r.id, r.sourceId])); }
    async history(userId, resourceType, id) {
        const r = this.rows.get(this.key(userId, resourceType, id));
        return r ? { firstReceivedAt: r.firstSeen, versions: r.versions } : { firstReceivedAt: null, versions: 0 };
    }
    /** Token values as the real index holds them: "code" and "system|code" per coding; text lowercased. */
    indexValues(resource, param) {
        const value = resource[param];
        const out = [];
        const ccs = Array.isArray(value) ? value : value ? [value] : [];
        for (const cc of ccs) {
            for (const c of (cc['coding'] ?? [])) {
                if (c.code) {
                    out.push(c.code);
                    if (c.system)
                        out.push(`${c.system}|${c.code}`);
                }
            }
            if (typeof cc['text'] === 'string')
                out.push(cc['text'].toLowerCase());
        }
        return out;
    }
    async indexedSearch(userId, resourceType, where) {
        return this.mine(userId).filter((r) => r.resourceType === resourceType && where.every((cond) => {
            const values = this.indexValues(r.resource, cond.param);
            return cond.alternatives.map((a) => a.trim()).filter(Boolean).some((a) => (a.endsWith('|') ? values.some((v) => v.startsWith(a)) : values.includes(a)));
        }));
    }
    async indexedValues(userId, resourceType, id, param) {
        const r = this.rows.get(this.key(userId, resourceType, id));
        return r ? this.indexValues(r.resource, param).filter((v) => v.includes('|')) : [];
    }
    async textSearch(userId, q, page) {
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0)
            return [];
        return this.mine(userId)
            .map((r) => ({ r, text: textFor(r.resource).toLowerCase() }))
            .filter(({ text }) => terms.every((t) => text.includes(t)))
            .slice(page.offset, page.offset + page.limit)
            .map(({ r, text }) => ({ resourceType: r.resourceType, id: r.id, snippet: text.slice(0, 60) }));
    }
    /** References found anywhere in the stored JSON — what the search index holds for reference parameters. */
    refsOf(resource, out = new Set()) {
        if (Array.isArray(resource))
            resource.forEach((v) => this.refsOf(v, out));
        else if (resource && typeof resource === 'object') {
            const o = resource;
            if (typeof o['reference'] === 'string' && /^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]+$/.test(o['reference']))
                out.add(o['reference']);
            Object.values(o).forEach((v) => this.refsOf(v, out));
        }
        return out;
    }
    async referencesFrom(userId, resourceType, id) {
        const r = this.rows.get(this.key(userId, resourceType, id));
        return r ? [...this.refsOf(r.resource)] : [];
    }
    async referencedBy(userId, reference) {
        return this.mine(userId).filter((r) => this.refsOf(r.resource).has(reference)).map((r) => ({ resourceType: r.resourceType, id: r.id }));
    }
    writer(userId, sourceId) {
        return {
            upsert: async (resource) => {
                const k = this.key(userId, resource.resourceType, resource.id ?? '');
                const existing = this.rows.get(k);
                if (existing && existing.sourceId !== sourceId)
                    throw new Error(`cross-source id collision: ${resource.resourceType}/${resource.id} is held from source ${existing.sourceId}`);
                const at = this.tick();
                this.rows.set(k, { userId, resourceType: resource.resourceType, id: resource.id ?? '', sourceId, lastUpdated: at, resource, versions: (existing?.versions ?? 0) + 1, firstSeen: existing?.firstSeen ?? at });
                return existing ? 'updated' : 'created';
            },
            exists: async (resourceType, id) => this.rows.has(this.key(userId, resourceType, id)),
        };
    }
    async removeBySource(userId, sourceId) {
        let n = 0;
        for (const [k, r] of this.rows)
            if (r.userId === userId && r.sourceId === sourceId) {
                this.rows.delete(k);
                n++;
            }
        return n;
    }
    async removeAll(userId) {
        let n = 0;
        for (const [k, r] of this.rows)
            if (r.userId === userId) {
                this.rows.delete(k);
                n++;
            }
        return n;
    }
    async release(userId) { this.released.push(userId); }
    async integrityOk() { return true; }
    storage() { return { location: ':memory:', sizeBytes: 0 }; }
    async backup(options) {
        this.backups.push({ destination: options.destination, key: options.key });
        return { file: `${options.destination}/fake.db`, sizeBytes: this.rows.size, pruned: [] };
    }
    staged = [];
    async stageRestore(backupFile, backupKey) {
        this.staged.push({ backupFile, backupKey });
        return { tables: 3 };
    }
}
//# sourceMappingURL=FakeRecordsProvider.js.map