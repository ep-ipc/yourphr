import { SqliteFhirRepository } from '../../SqliteFhirRepository.js';
import { dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { backupDatabase, stageInstanceRestore } from './sqlite-backup.js';
import { ftsQuery } from './record-text.js';
import { BaseRecordsProvider } from './BaseRecordsProvider.js';
const REFERENCE_SHAPE = /^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/;
const PARAM_NAME = /^[a-z][a-z0-9-]*$/i;
const DATE_PREFIX = /^(eq|ne|gt|ge|lt|le|sa|eb|ap)(\d.*)$/;
export class SqliteRecordsProvider extends BaseRecordsProvider {
    file;
    key;
    handles = new Map();
    constructor(file, key) {
        super();
        this.file = file;
        this.key = key;
    }
    /**
     * For the contract harnesses that open a repository themselves: a provider over the same store,
     * seeded with that handle for its account. Other accounts get their own handle on the file, so
     * the per-user isolation the harnesses test is the real one.
     */
    static overRepository(repo) {
        const p = new SqliteRecordsProvider(repo.file, repo.key);
        p.handles.set(repo.userId ?? '', repo);
        p.borrowed.add(repo);
        return p;
    }
    /** Handles the caller owns: never closed here. */
    borrowed = new Set();
    async initialize() {
        // Open once so the schema exists and the file is proven openable under the key at boot,
        // rather than at the first request.
        this.handle('__boot__').db.close();
        this.handles.delete('__boot__');
    }
    async close() {
        const seen = new Set();
        for (const h of this.handles.values()) {
            if (seen.has(h) || this.borrowed.has(h))
                continue;
            seen.add(h);
            h.db.close();
        }
        this.handles.clear();
    }
    /** The per-account handle. Deliberately not public: a handle is the store, and the store is the provider's. */
    handle(userId) {
        let h = this.handles.get(userId);
        if (!h) {
            h = new SqliteFhirRepository({ file: this.file, userId, key: this.key });
            this.handles.set(userId, h);
        }
        return h;
    }
    anyDb() {
        return this.handle('__any__').db;
    }
    toStored(row) {
        return { resourceType: row.resource_type, id: row.id, sourceId: row.source_id, lastUpdated: row.last_updated, resource: JSON.parse(row.content) };
    }
    async search(userId, request) {
        return this.handle(userId).search(request);
    }
    async read(userId, resourceType, id) {
        const row = this.anyDb()
            .prepare('SELECT resource_type, id, source_id, last_updated, content FROM resources WHERE resource_type = ? AND id = ? AND user_id = ? AND deleted = 0')
            .get(resourceType, id, userId);
        return row ? this.toStored(row) : undefined;
    }
    async readById(userId, id) {
        const row = this.anyDb()
            .prepare('SELECT resource_type, id, source_id, last_updated, content FROM resources WHERE id = ? AND user_id = ? AND deleted = 0')
            .get(id, userId);
        return row ? this.toStored(row) : undefined;
    }
    async list(userId, filter = {}) {
        const where = ['user_id = ?', 'deleted = 0'];
        const params = [userId];
        if (filter.resourceType !== undefined) {
            where.push('resource_type = ?');
            params.push(filter.resourceType);
        }
        if (filter.sourceId !== undefined) {
            where.push('source_id = ?');
            params.push(filter.sourceId);
        }
        const rows = this.anyDb()
            .prepare(`SELECT resource_type, id, source_id, last_updated, content FROM resources WHERE ${where.join(' AND ')} ORDER BY resource_type, id`)
            .all(...params);
        return rows.map((r) => this.toStored(r));
    }
    async countByType(userId, sourceId) {
        const rows = sourceId === undefined
            ? this.anyDb().prepare('SELECT resource_type, COUNT(*) AS count FROM resources WHERE user_id = ? AND deleted = 0 GROUP BY resource_type ORDER BY resource_type').all(userId)
            : this.anyDb().prepare('SELECT resource_type, COUNT(*) AS count FROM resources WHERE user_id = ? AND source_id = ? AND deleted = 0 GROUP BY resource_type ORDER BY resource_type').all(userId, sourceId);
        return rows.map((r) => ({ resourceType: r.resource_type, count: r.count }));
    }
    async typesHeld(userId) {
        return this.anyDb().prepare('SELECT DISTINCT resource_type AS t FROM resources WHERE user_id = ? AND deleted = 0 ORDER BY t').all(userId).map((r) => r.t);
    }
    async sourceOf(userId, resourceType) {
        const rows = this.anyDb().prepare('SELECT id, source_id FROM resources WHERE resource_type = ? AND user_id = ?').all(resourceType, userId);
        return new Map(rows.map((r) => [r.id, r.source_id]));
    }
    async history(userId, resourceType, id) {
        const row = this.anyDb()
            .prepare('SELECT MIN(h.last_updated) AS first, COUNT(*) AS n FROM resource_history h JOIN resources r ON r.resource_type = h.resource_type AND r.id = h.id WHERE h.resource_type = ? AND h.id = ? AND r.user_id = ?')
            .get(resourceType, id, userId);
        return { firstReceivedAt: row.first, versions: row.n };
    }
    async indexedSearch(userId, resourceType, where) {
        const clauses = [];
        const values = [];
        for (const cond of where) {
            if (!PARAM_NAME.test(cond.param))
                throw new Error(`invalid search parameter: ${cond.param}`);
            const alternatives = cond.alternatives.map((a) => a.trim()).filter(Boolean);
            if (alternatives.length === 0)
                continue;
            const parts = alternatives.map((v) => {
                const prefixed = v.match(DATE_PREFIX);
                if (prefixed) {
                    const op = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=', sa: '>', eb: '<', ap: '=' }[prefixed[1]];
                    return { sql: `si.value ${op} ?`, values: [prefixed[2]] };
                }
                if (v.endsWith('|'))
                    return { sql: "si.value LIKE ? ESCAPE '\\'", values: [`${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] };
                return { sql: 'si.value = ?', values: [v] };
            });
            clauses.push(`EXISTS (SELECT 1 FROM search_index si WHERE si.resource_type = r.resource_type AND si.resource_id = r.id AND si.user_id = r.user_id AND si.code = ? AND (${parts.map((p) => p.sql).join(' OR ')}))`);
            values.push(cond.param, ...parts.flatMap((p) => p.values));
        }
        const rows = this.anyDb()
            .prepare(`SELECT r.resource_type, r.id, r.source_id, r.last_updated, r.content FROM resources r WHERE r.resource_type = ? AND r.user_id = ? AND r.deleted = 0${clauses.length ? ' AND ' + clauses.join(' AND ') : ''}`)
            .all(resourceType, userId, ...values);
        return rows.map((r) => this.toStored(r));
    }
    async indexedValues(userId, resourceType, id, param) {
        if (!PARAM_NAME.test(param))
            throw new Error(`invalid search parameter: ${param}`);
        return this.anyDb()
            .prepare("SELECT value FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ? AND code = ? AND value LIKE '%|%'")
            .all(resourceType, id, userId, param).map((v) => v.value);
    }
    async textSearch(userId, q, page) {
        const match = ftsQuery(q);
        if (match === '')
            return [];
        const rows = this.anyDb()
            .prepare(`SELECT t.resource_type, t.resource_id, snippet(search_text, 3, '[', ']', '…', 12) AS snippet
                FROM search_text t JOIN resources r ON r.resource_type = t.resource_type AND r.id = t.resource_id AND r.user_id = t.user_id
                WHERE t.user_id = ? AND search_text MATCH ? AND r.deleted = 0
                ORDER BY bm25(search_text) LIMIT ? OFFSET ?`)
            .all(userId, match, page.limit, page.offset);
        return rows.map((r) => ({ resourceType: r.resource_type, id: r.resource_id, snippet: r.snippet }));
    }
    async referencesFrom(userId, resourceType, id) {
        // A reference value is "Type/id"; a token is "system|code"; dates and strings carry neither shape.
        return this.anyDb()
            .prepare("SELECT DISTINCT value FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ? AND value GLOB '[A-Z]*/*' AND value NOT LIKE '%|%' AND value NOT LIKE '% %'")
            .all(resourceType, id, userId).map((v) => v.value).filter((v) => REFERENCE_SHAPE.test(v));
    }
    async referencedBy(userId, reference) {
        return this.anyDb()
            .prepare('SELECT DISTINCT resource_type, resource_id FROM search_index WHERE user_id = ? AND value = ?')
            .all(userId, reference).map((r) => ({ resourceType: r.resource_type, id: r.resource_id }));
    }
    writer(userId, sourceId) {
        const repo = this.handle(userId);
        return {
            upsert: async (resource) => {
                const existed = await this.read(userId, resource.resourceType, resource.id ?? '');
                // Scoped to this write and restored afterwards: the handle is shared, and leaving a source
                // attributed would silently change what every later write means.
                const previous = repo.sourceId;
                repo.sourceId = sourceId;
                try {
                    await repo.updateResource(resource);
                }
                finally {
                    repo.sourceId = previous;
                }
                return existed ? 'updated' : 'created';
            },
            exists: async (resourceType, id) => (await this.read(userId, resourceType, id)) !== undefined,
        };
    }
    async removeBySource(userId, sourceId) {
        const db = this.anyDb();
        const remove = db.transaction(() => {
            const rows = db.prepare('SELECT resource_type, id FROM resources WHERE user_id = ? AND source_id = ?').all(userId, sourceId);
            const delIndex = db.prepare('DELETE FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ?');
            const delText = db.prepare('DELETE FROM search_text WHERE resource_type = ? AND resource_id = ? AND user_id = ?');
            const delHistory = db.prepare('DELETE FROM resource_history WHERE resource_type = ? AND id = ?');
            for (const r of rows) {
                delIndex.run(r.resource_type, r.id, userId);
                delText.run(r.resource_type, r.id, userId);
                delHistory.run(r.resource_type, r.id);
            }
            return db.prepare('DELETE FROM resources WHERE user_id = ? AND source_id = ?').run(userId, sourceId).changes;
        });
        return remove();
    }
    async removeAll(userId) {
        const db = this.anyDb();
        const remove = db.transaction(() => {
            const rows = db.prepare('SELECT resource_type, id FROM resources WHERE user_id = ?').all(userId);
            const delHistory = db.prepare('DELETE FROM resource_history WHERE resource_type = ? AND id = ?');
            for (const r of rows)
                delHistory.run(r.resource_type, r.id);
            db.prepare('DELETE FROM search_index WHERE user_id = ?').run(userId);
            db.prepare('DELETE FROM search_text WHERE user_id = ?').run(userId);
            return db.prepare('DELETE FROM resources WHERE user_id = ?').run(userId).changes;
        });
        return remove();
    }
    async release(userId) {
        const h = this.handles.get(userId);
        if (h) {
            if (!this.borrowed.has(h))
                h.db.close();
            this.handles.delete(userId);
        }
    }
    storage() {
        return { location: this.file, sizeBytes: existsSync(this.file) ? statSync(this.file).size : 0 };
    }
    async integrityOk() {
        try {
            return String(this.anyDb().pragma('quick_check')[0]?.quick_check ?? '').toLowerCase() === 'ok';
        }
        catch {
            return false;
        }
    }
    async backup(options) {
        return backupDatabase(this.handle('__any__'), {
            destination: options.destination,
            backupKey: options.key,
            maxBackups: options.maxBackups,
            now: options.now,
            alsoExport: options.alsoExport,
        });
    }
    async stageRestore(backupFile, backupKey) {
        return stageInstanceRestore(backupFile, backupKey, dirname(this.file), this.key ?? '');
    }
}
//# sourceMappingURL=SqliteRecordsProvider.js.map