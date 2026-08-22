/**
 * PHI storage over SQLCipher (yourphr#609): `SqliteFhirRepository` — the generic FHIR store the
 * spike proved (551 lines against 18,518 generated ones, 29/29 resource types id-for-id) — as the
 * one-active records provider. One file, one key, one handle per account (the per-user isolation
 * seam, yourphr#537). Every raw query over records lives in this file and nowhere else; the
 * store-boundary lint keeps it that way.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import type { SearchRequest, WithId } from '@medplum/core';
import { SqliteFhirRepository } from '../../SqliteFhirRepository.js';
import { dirname } from 'node:path';
import { backupDatabase, stageInstanceRestore } from './sqlite-backup.js';
import { BaseRecordsProvider, type IndexCondition, type RecordsWriter, type StoredRecord } from './BaseRecordsProvider.js';

const PARAM_NAME = /^[a-z][a-z0-9-]*$/i;
const DATE_PREFIX = /^(eq|ne|gt|ge|lt|le|sa|eb|ap)(\d.*)$/;

export class SqliteRecordsProvider extends BaseRecordsProvider {
  private readonly handles = new Map<string, SqliteFhirRepository>();

  constructor(private readonly file: string, private readonly key: string | undefined) {
    super();
  }

  /**
   * For the contract harnesses that open a repository themselves: a provider over the same store,
   * seeded with that handle for its account. Other accounts get their own handle on the file, so
   * the per-user isolation the harnesses test is the real one.
   */
  static overRepository(repo: SqliteFhirRepository): SqliteRecordsProvider {
    const p = new SqliteRecordsProvider(repo.file, repo.key);
    p.handles.set(repo.userId ?? '', repo);
    p.borrowed.add(repo);
    return p;
  }
  /** Handles the caller owns: never closed here. */
  private readonly borrowed = new Set<SqliteFhirRepository>();

  async initialize(): Promise<void> {
    // Open once so the schema exists and the file is proven openable under the key at boot,
    // rather than at the first request.
    this.handle('__boot__').db.close();
    this.handles.delete('__boot__');
  }

  async close(): Promise<void> {
    const seen = new Set<SqliteFhirRepository>();
    for (const h of this.handles.values()) {
      if (seen.has(h) || this.borrowed.has(h)) continue;
      seen.add(h);
      h.db.close();
    }
    this.handles.clear();
  }

  /** The per-account handle. Deliberately not public: a handle is the store, and the store is the provider's. */
  private handle(userId: string): SqliteFhirRepository {
    let h = this.handles.get(userId);
    if (!h) {
      h = new SqliteFhirRepository({ file: this.file, userId, key: this.key });
      this.handles.set(userId, h);
    }
    return h;
  }

  private anyDb(): InstanceType<typeof Database> {
    return this.handle('__any__').db;
  }

  private toStored(row: { resource_type: string; id: string; source_id: string; last_updated: string; content: string }): StoredRecord {
    return { resourceType: row.resource_type, id: row.id, sourceId: row.source_id, lastUpdated: row.last_updated, resource: JSON.parse(row.content) as Resource };
  }

  async search<T extends Resource>(userId: string, request: SearchRequest<T>): Promise<Bundle<WithId<T>>> {
    return this.handle(userId).search(request);
  }

  async read(userId: string, resourceType: string, id: string): Promise<StoredRecord | undefined> {
    const row = this.anyDb()
      .prepare('SELECT resource_type, id, source_id, last_updated, content FROM resources WHERE resource_type = ? AND id = ? AND user_id = ? AND deleted = 0')
      .get(resourceType, id, userId) as Parameters<SqliteRecordsProvider['toStored']>[0] | undefined;
    return row ? this.toStored(row) : undefined;
  }

  async readById(userId: string, id: string): Promise<StoredRecord | undefined> {
    const row = this.anyDb()
      .prepare('SELECT resource_type, id, source_id, last_updated, content FROM resources WHERE id = ? AND user_id = ? AND deleted = 0')
      .get(id, userId) as Parameters<SqliteRecordsProvider['toStored']>[0] | undefined;
    return row ? this.toStored(row) : undefined;
  }

  async list(userId: string, filter: { resourceType?: string; sourceId?: string } = {}): Promise<StoredRecord[]> {
    const where = ['user_id = ?', 'deleted = 0'];
    const params: unknown[] = [userId];
    if (filter.resourceType !== undefined) { where.push('resource_type = ?'); params.push(filter.resourceType); }
    if (filter.sourceId !== undefined) { where.push('source_id = ?'); params.push(filter.sourceId); }
    const rows = this.anyDb()
      .prepare(`SELECT resource_type, id, source_id, last_updated, content FROM resources WHERE ${where.join(' AND ')} ORDER BY resource_type, id`)
      .all(...params) as Parameters<SqliteRecordsProvider['toStored']>[0][];
    return rows.map((r) => this.toStored(r));
  }

  async countByType(userId: string, sourceId?: string): Promise<{ resourceType: string; count: number }[]> {
    const rows = sourceId === undefined
      ? this.anyDb().prepare('SELECT resource_type, COUNT(*) AS count FROM resources WHERE user_id = ? AND deleted = 0 GROUP BY resource_type ORDER BY resource_type').all(userId)
      : this.anyDb().prepare('SELECT resource_type, COUNT(*) AS count FROM resources WHERE user_id = ? AND source_id = ? AND deleted = 0 GROUP BY resource_type ORDER BY resource_type').all(userId, sourceId);
    return (rows as { resource_type: string; count: number }[]).map((r) => ({ resourceType: r.resource_type, count: r.count }));
  }

  async typesHeld(userId: string): Promise<string[]> {
    return (this.anyDb().prepare('SELECT DISTINCT resource_type AS t FROM resources WHERE user_id = ? AND deleted = 0 ORDER BY t').all(userId) as { t: string }[]).map((r) => r.t);
  }

  async sourceOf(userId: string, resourceType: string): Promise<Map<string, string>> {
    const rows = this.anyDb().prepare('SELECT id, source_id FROM resources WHERE resource_type = ? AND user_id = ?').all(resourceType, userId) as { id: string; source_id: string }[];
    return new Map(rows.map((r) => [r.id, r.source_id]));
  }

  async history(userId: string, resourceType: string, id: string): Promise<{ firstReceivedAt: string | null; versions: number }> {
    const row = this.anyDb()
      .prepare('SELECT MIN(h.last_updated) AS first, COUNT(*) AS n FROM resource_history h JOIN resources r ON r.resource_type = h.resource_type AND r.id = h.id WHERE h.resource_type = ? AND h.id = ? AND r.user_id = ?')
      .get(resourceType, id, userId) as { first: string | null; n: number };
    return { firstReceivedAt: row.first, versions: row.n };
  }

  async indexedSearch(userId: string, resourceType: string, where: IndexCondition[]): Promise<StoredRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const cond of where) {
      if (!PARAM_NAME.test(cond.param)) throw new Error(`invalid search parameter: ${cond.param}`);
      const alternatives = cond.alternatives.map((a) => a.trim()).filter(Boolean);
      if (alternatives.length === 0) continue;
      const parts = alternatives.map((v) => {
        const prefixed = v.match(DATE_PREFIX);
        if (prefixed) {
          const op = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=', sa: '>', eb: '<', ap: '=' }[prefixed[1]!]!;
          return { sql: `si.value ${op} ?`, values: [prefixed[2]!] };
        }
        if (v.endsWith('|')) return { sql: "si.value LIKE ? ESCAPE '\\'", values: [`${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] };
        return { sql: 'si.value = ?', values: [v] };
      });
      clauses.push(`EXISTS (SELECT 1 FROM search_index si WHERE si.resource_type = r.resource_type AND si.resource_id = r.id AND si.user_id = r.user_id AND si.code = ? AND (${parts.map((p) => p.sql).join(' OR ')}))`);
      values.push(cond.param, ...parts.flatMap((p) => p.values));
    }
    const rows = this.anyDb()
      .prepare(`SELECT r.resource_type, r.id, r.source_id, r.last_updated, r.content FROM resources r WHERE r.resource_type = ? AND r.user_id = ? AND r.deleted = 0${clauses.length ? ' AND ' + clauses.join(' AND ') : ''}`)
      .all(resourceType, userId, ...values) as Parameters<SqliteRecordsProvider['toStored']>[0][];
    return rows.map((r) => this.toStored(r));
  }

  async indexedValues(userId: string, resourceType: string, id: string, param: string): Promise<string[]> {
    if (!PARAM_NAME.test(param)) throw new Error(`invalid search parameter: ${param}`);
    return (this.anyDb()
      .prepare("SELECT value FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ? AND code = ? AND value LIKE '%|%'")
      .all(resourceType, id, userId, param) as { value: string }[]).map((v) => v.value);
  }

  writer(userId: string, sourceId: string): RecordsWriter {
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
        } finally {
          repo.sourceId = previous;
        }
        return existed ? 'updated' : 'created';
      },
      exists: async (resourceType, id) => (await this.read(userId, resourceType, id)) !== undefined,
    };
  }

  async removeBySource(userId: string, sourceId: string): Promise<number> {
    const db = this.anyDb();
    const remove = db.transaction((): number => {
      const rows = db.prepare('SELECT resource_type, id FROM resources WHERE user_id = ? AND source_id = ?').all(userId, sourceId) as { resource_type: string; id: string }[];
      const delIndex = db.prepare('DELETE FROM search_index WHERE resource_type = ? AND resource_id = ? AND user_id = ?');
      const delHistory = db.prepare('DELETE FROM resource_history WHERE resource_type = ? AND id = ?');
      for (const r of rows) {
        delIndex.run(r.resource_type, r.id, userId);
        delHistory.run(r.resource_type, r.id);
      }
      return db.prepare('DELETE FROM resources WHERE user_id = ? AND source_id = ?').run(userId, sourceId).changes;
    });
    return remove();
  }

  async removeAll(userId: string): Promise<number> {
    const db = this.anyDb();
    const remove = db.transaction((): number => {
      const rows = db.prepare('SELECT resource_type, id FROM resources WHERE user_id = ?').all(userId) as { resource_type: string; id: string }[];
      const delHistory = db.prepare('DELETE FROM resource_history WHERE resource_type = ? AND id = ?');
      for (const r of rows) delHistory.run(r.resource_type, r.id);
      db.prepare('DELETE FROM search_index WHERE user_id = ?').run(userId);
      return db.prepare('DELETE FROM resources WHERE user_id = ?').run(userId).changes;
    });
    return remove();
  }

  async release(userId: string): Promise<void> {
    const h = this.handles.get(userId);
    if (h) {
      if (!this.borrowed.has(h)) h.db.close();
      this.handles.delete(userId);
    }
  }

  async integrityOk(): Promise<boolean> {
    try {
      return String((this.anyDb().pragma('quick_check') as { quick_check: string }[])[0]?.quick_check ?? '').toLowerCase() === 'ok';
    } catch {
      return false;
    }
  }

  async backup(options: { destination: string; key: string; maxBackups?: number; now?: Date; alsoExport?: unknown[] }): Promise<{ file: string; sizeBytes: number; pruned: string[] }> {
    return backupDatabase(this.handle('__any__'), {
      destination: options.destination,
      backupKey: options.key,
      maxBackups: options.maxBackups,
      now: options.now,
      alsoExport: options.alsoExport as InstanceType<typeof Database>[] | undefined,
    });
  }

  async stageRestore(backupFile: string, backupKey: string): Promise<{ tables: number }> {
    return stageInstanceRestore(backupFile, backupKey, dirname(this.file), this.key ?? '');
  }
}
