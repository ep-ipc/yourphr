import { BaseManager } from '../../framework/BaseManager.js';
import { ApiError } from '../../framework/ApiContext.js';
import { reconcileConditions } from '../../conditions/index.js';
import { classifyAllergies } from '../../allergies/index.js';
import { classifyImmunizations } from '../../immunizations/index.js';
import { reconcile as reconcileMedications } from '../../medication/index.js';
import { buildIps } from '../../ips/index.js';
import { dateFor, toResourceFhir } from '../../server.js';
const PARAM_NAME = /^[a-z][a-z0-9-]*$/i;
export class RecordsManager extends BaseManager {
    provider;
    favoritesProvider;
    name = 'records';
    /** Reads no configuration today; declared empty rather than pretending (the engine validates what is declared). */
    dependsOn = [];
    /** Maps a source id to its display name; '' when unknown — never invent. Set by the app until Sources is a manager. */
    sourceDisplay = () => '';
    constructor(engine, provider, favoritesProvider) {
        super(engine);
        this.provider = provider;
        this.favoritesProvider = favoritesProvider;
    }
    async initialize(config = {}) {
        await this.provider.initialize();
        await this.favoritesProvider?.initialize();
        await super.initialize(config);
    }
    async shutdown() {
        await this.provider.close();
        await super.shutdown();
    }
    who(ctx) {
        ctx.requireAuthenticated();
        return ctx.username;
    }
    // --- the record pages ---
    /** GET /resource/fhir?sourceResourceType=…[&sourceID=…] — YourPHR's resource_fhir rows. */
    async list(ctx, resourceType, options = {}) {
        const userId = this.who(ctx);
        const bundle = await this.provider.search(userId, { resourceType: resourceType, count: options.limit ?? 100000, total: 'accurate' });
        const sourceOf = await this.provider.sourceOf(userId, resourceType);
        return (bundle.entry ?? [])
            .map((e) => e.resource)
            .filter((r) => !options.sourceId || sourceOf.get(r.id ?? '') === options.sourceId)
            .map((r) => toResourceFhir(r, sourceOf.get(r.id ?? '') ?? ''));
    }
    /** GET /resource/fhir/:source/:id — addressed by id without its type, as YourPHR does. */
    async detail(ctx, id) {
        const stored = await this.provider.readById(this.who(ctx), id);
        if (!stored)
            throw new ApiError(404, 'not found');
        return toResourceFhir(stored.resource, stored.sourceId);
    }
    async search(ctx, request) {
        return this.provider.search(this.who(ctx), request);
    }
    /** GET /summary's counts. */
    async countsByType(ctx, sourceId) {
        return (await this.provider.countByType(this.who(ctx), sourceId)).map((c) => ({ resource_type: c.resourceType, count: c.count }));
    }
    async typesHeld(ctx) {
        return this.provider.typesHeld(this.who(ctx));
    }
    /** The dashboard's recent activity: newest records across every type, Go's list-item shape. */
    async recent(ctx, limit) {
        const items = (await this.provider.list(this.who(ctx))).map((r) => {
            const shaped = toResourceFhir(r.resource, r.sourceId);
            const date = String(shaped['sort_date'] ?? '').slice(0, 10);
            return { source_id: r.sourceId, source_resource_type: r.resourceType, source_resource_id: r.id, title: String(shaped['sort_title'] ?? ''), ...(date ? { date } : {}) };
        });
        items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
        return items.slice(0, limit);
    }
    async inputs(ctx, resourceType) {
        return (await this.provider.list(this.who(ctx), { resourceType }))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((r) => ({ sourceResourceType: resourceType, sourceResourceId: r.id, sourceId: r.sourceId, raw: r.resource }));
    }
    async conditions(ctx) { return reconcileConditions(await this.inputs(ctx, 'Condition')); }
    async allergies(ctx) { return classifyAllergies(await this.inputs(ctx, 'AllergyIntolerance')); }
    async immunizations(ctx) { return classifyImmunizations(await this.inputs(ctx, 'Immunization')); }
    async medications(ctx) {
        const inputs = [];
        for (const type of ['MedicationRequest', 'MedicationStatement', 'MedicationDispense']) {
            for (const r of await this.provider.list(this.who(ctx), { resourceType: type }))
                inputs.push({ resource: r.resource, sourceId: r.sourceId });
        }
        return reconcileMedications(inputs);
    }
    async ips(ctx, now = new Date()) {
        const userId = this.who(ctx);
        return buildIps({ search: (request) => this.provider.search(userId, request) }, now);
    }
    async provenance(ctx, resourceType, id) {
        const userId = this.who(ctx);
        const stored = await this.provider.read(userId, resourceType, id);
        if (!stored)
            return undefined;
        const history = await this.provider.history(userId, resourceType, id);
        const display = stored.sourceId === '' ? 'This instance (manual entry or upload)' : (await this.sourceDisplay(stored.sourceId)) || stored.sourceId;
        return {
            resourceType, id, sourceId: stored.sourceId, sourceDisplay: display,
            firstReceivedAt: history.firstReceivedAt ?? stored.lastUpdated, lastConfirmedAt: stored.lastUpdated, timesSeen: Math.max(history.versions, 1),
        };
    }
    /**
     * The typed query (POST /query): where (comma = OR, parameters AND; tokens as code, system|code,
     * system|; date prefixes), limit/offset, group_by with count or max/min(sort_date), count_by.
     */
    async query(ctx, query) {
        const userId = this.who(ctx);
        if (!/^[A-Z][A-Za-z]+$/.test(query.from ?? ''))
            throw new ApiError(400, 'from must name a resource type');
        const where = Object.entries(query.where ?? {}).map(([param, raw]) => {
            if (!PARAM_NAME.test(param))
                throw new ApiError(400, `invalid search parameter: ${param}`);
            return { param, alternatives: (Array.isArray(raw) ? raw : [raw]).flatMap((s) => String(s).split(',')) };
        });
        const rows = await this.provider.indexedSearch(userId, query.from, where);
        const sortDate = (r) => String(dateFor(r.resource) ?? '');
        const agg = query.aggregations;
        let groupBy = agg?.group_by;
        let orderBy = agg?.order_by;
        if (agg?.count_by) {
            groupBy = agg.count_by.field === '*' ? { field: 'source_resource_type' } : agg.count_by;
            orderBy = { field: '*', fn: 'count' };
        }
        if (!groupBy) {
            rows.sort((a, b) => sortDate(b).localeCompare(sortDate(a)));
            const offset = query.offset ?? 0;
            return rows.slice(offset, offset + (query.limit ?? 100)).map((r) => toResourceFhir(r.resource, r.sourceId));
        }
        if (!PARAM_NAME.test(groupBy.field) && groupBy.field !== 'source_resource_type')
            throw new ApiError(400, `invalid aggregation field: ${groupBy.field}`);
        const byDate = orderBy !== undefined && orderBy.field !== '*';
        if (byDate && orderBy.field !== 'sort_date')
            throw new ApiError(400, `unsupported order_by field: ${orderBy.field} (sort_date only)`);
        const groups = new Map();
        for (const r of rows) {
            const labels = groupBy.field === 'source_resource_type' ? [query.from] : await this.provider.indexedValues(userId, query.from, r.id, groupBy.field);
            const date = sortDate(r);
            for (const label of labels) {
                const g = groups.get(label) ?? { count: 0, max: '', min: '' };
                g.count++;
                if (date !== '' && (g.max === '' || date > g.max))
                    g.max = date;
                if (date !== '' && (g.min === '' || date < g.min))
                    g.min = date;
                groups.set(label, g);
            }
        }
        const out = [...groups.entries()].map(([label, g]) => ({ label, value: byDate ? ((orderBy.fn ?? 'max') === 'min' ? g.min : g.max) : g.count }));
        out.sort((a, b) => (typeof a.value === 'number' && typeof b.value === 'number' ? b.value - a.value : String(b.value).localeCompare(String(a.value))));
        return out;
    }
    // --- per source (the Sources page; Sources stays a store until its own child) ---
    async sourceCounts(ctx, sourceId) {
        return (await this.provider.countByType(this.who(ctx), sourceId)).map((c) => ({ source_id: sourceId, resource_type: c.resourceType, count: c.count }));
    }
    async patientOf(ctx, sourceId) {
        const patients = (await this.provider.list(this.who(ctx), { resourceType: 'Patient', sourceId })).sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
        return patients[0] ? toResourceFhir(patients[0].resource, sourceId) : null;
    }
    async exportSource(ctx, sourceId) {
        const entry = (await this.provider.list(this.who(ctx), { sourceId })).map((r) => ({ resource: r.resource }));
        return { resourceType: 'Bundle', type: 'collection', total: entry.length, entry };
    }
    /** Removes every record a source wrote for the caller: rows, index, history. Returns the row count. */
    async removeSource(ctx, sourceId) {
        return this.provider.removeBySource(this.who(ctx), sourceId);
    }
    /** Everything the caller holds, then the handle — the account is going. */
    async removeAll(ctx) {
        const userId = this.who(ctx);
        const n = await this.provider.removeAll(userId);
        await this.favoritesProvider?.removeAll(userId);
        await this.provider.release(userId);
        return n;
    }
    // --- find anything by words (yourphr#599) ---
    /**
     * GET /secure/resources/search?q=…: the caller's records whose human-readable text matches every
     * word, best match first, in the dashboard's ResourceListItem shape plus a snippet. Under two
     * characters answers nothing (Go's rule for the same box). Isolation is the owner seam: the
     * provider searches one account's text and nothing else.
     */
    async searchText(ctx, q, page = {}) {
        const userId = this.who(ctx);
        const query = q.trim();
        if (query.length < 2)
            return [];
        const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);
        const offset = Math.max(page.page ?? 0, 0) * limit;
        const hits = await this.provider.textSearch(userId, query, { limit, offset });
        const items = [];
        for (const hit of hits) {
            const stored = await this.provider.read(userId, hit.resourceType, hit.id);
            if (!stored)
                continue;
            const shaped = toResourceFhir(stored.resource, stored.sourceId);
            const date = String(shaped['sort_date'] ?? '').slice(0, 10);
            items.push({ source_id: stored.sourceId, source_resource_type: stored.resourceType, source_resource_id: stored.id, title: String(shaped['sort_title'] ?? '') || stored.resourceType, ...(date ? { date } : {}), snippet: hit.snippet });
        }
        return items;
    }
    // --- the resource graph (yourphr#605): Go's MedicalHistory graph, scoped to what the page reads ---
    /**
     * POST /secure/resource/graph/MedicalHistory. Go builds a directed graph of every record (vertices)
     * and reference (edges), reverses edges into the graph's "source" types so Encounters are roots,
     * then flattens each requested root: every record reachable from it, in either direction, except
     * Binary, deduplicated, newest first. Here the edges are the search index's reference values —
     * a query, not a crawl — walked both ways from each requested record. Only MedicalHistory exists;
     * the page asks for its Encounters and reads `related_resources` off each.
     */
    async graph(ctx, graphType, ids) {
        const userId = this.who(ctx);
        if (graphType !== 'MedicalHistory')
            throw new ApiError(400, `unsupported graph type ${JSON.stringify(graphType)} — only MedicalHistory exists here`);
        if (!Array.isArray(ids) || ids.length === 0)
            throw new ApiError(400, 'resource_ids is required');
        const byDateDesc = (a, b) => String(b['sort_date'] ?? '').localeCompare(String(a['sort_date'] ?? ''));
        const results = {};
        for (const id of ids) {
            const resourceType = String(id.source_resource_type ?? '');
            const resourceId = String(id.source_resource_id ?? '');
            if (!resourceType || !resourceId)
                continue;
            const root = await this.provider.read(userId, resourceType, resourceId);
            if (!root)
                continue; // not this account's, or gone — silently absent, as Go's IN query leaves it
            const rootKey = `${resourceType}/${resourceId}`;
            const visited = new Set([rootKey]);
            const queue = [rootKey];
            const related = [];
            while (queue.length > 0) {
                const current = queue.shift();
                const [type, rid] = current.split('/');
                const neighbours = new Set(await this.provider.referencesFrom(userId, type, rid));
                for (const r of await this.provider.referencedBy(userId, current))
                    neighbours.add(`${r.resourceType}/${r.id}`);
                for (const next of neighbours) {
                    if (visited.has(next) || next.startsWith('Binary/'))
                        continue;
                    visited.add(next);
                    const [nType, nId] = next.split('/');
                    const stored = await this.provider.read(userId, nType, nId);
                    if (!stored)
                        continue; // a dangling reference: the record was never synced
                    related.push(toResourceFhir(stored.resource, stored.sourceId));
                    queue.push(next);
                }
            }
            related.sort(byDateDesc);
            (results[resourceType] ??= []).push({ ...toResourceFhir(root.resource, root.sourceId), related_resources: related });
        }
        for (const list of Object.values(results))
            list.sort(byDateDesc);
        return { results };
    }
    // --- favourites (yourphr#616): an annotation on a record, through the same door ---
    /** Only Practitioner is starred — the one kind the UI stars, so a typo cannot star the world. */
    static supportsFavorites(resourceType) {
        return resourceType === 'Practitioner';
    }
    favorites_() {
        if (!this.favoritesProvider)
            throw new ApiError(501, 'favourites are not available on this instance');
        return this.favoritesProvider;
    }
    checkFavorite(fav) {
        if (!fav.source_id || !fav.resource_type || !fav.resource_id)
            throw new ApiError(400, 'invalid request payload');
        if (!RecordsManager.supportsFavorites(fav.resource_type))
            throw new ApiError(400, 'only Practitioner resources are supported');
    }
    async favorites(ctx, resourceType) {
        const userId = this.who(ctx);
        if (!RecordsManager.supportsFavorites(resourceType))
            throw new ApiError(400, 'only Practitioner resources are supported');
        return this.favorites_().list(userId, resourceType);
    }
    async addFavorite(ctx, fav, at = new Date()) {
        const userId = this.who(ctx);
        this.checkFavorite(fav);
        await this.favorites_().add(userId, fav, at);
        return fav;
    }
    async removeFavorite(ctx, fav) {
        const userId = this.who(ctx);
        this.checkFavorite(fav);
        return this.favorites_().remove(userId, fav);
    }
    // --- writes: the worker and the migration tool ---
    /** A writer bound to the caller's account and one source — what a sync pass or an import writes through. */
    writer(ctx, sourceId) {
        return this.provider.writer(this.who(ctx), sourceId);
    }
    async exists(ctx, resourceType, id) {
        return (await this.provider.read(this.who(ctx), resourceType, id)) !== undefined;
    }
    // --- the base contract ---
    async integrityOk() {
        return this.provider.integrityOk();
    }
    /** The admin's Database card: where the PHI store lives and its size. */
    storage(ctx) {
        ctx.require('admin-read');
        return this.provider.storage();
    }
    async backup(options) {
        const result = await this.provider.backup(options);
        return { manager: this.name, takenAt: (options.now ?? new Date()).toISOString(), files: [result.file], ...result };
    }
    /** The base contract (yourphr#615): the backup named in `data.files` is staged under this store's key and applied at the next start — a live file is never overwritten. */
    async restore(data, options) {
        const file = data.files?.[0];
        if (!file)
            throw new ApiError(400, 'a records restore needs the backup file to stage');
        await this.provider.stageRestore(file, options.key);
    }
}
//# sourceMappingURL=RecordsManager.js.map