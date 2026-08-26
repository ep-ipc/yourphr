import { BaseJobsProvider } from './BaseJobsProvider.js';
export class SqliteJobsProvider extends BaseJobsProvider {
    db;
    constructor(db) {
        super();
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      received INTEGER NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    )`);
    }
    async initialize() { }
    toJob(r) {
        return { id: r['id'], sourceId: r['source_id'], outcome: r['outcome'], received: r['received'], created: r['created'], updated: r['updated'], error: r['error'], startedAt: r['started_at'], finishedAt: r['finished_at'] };
    }
    async record(job) {
        const info = this.db
            .prepare('INSERT INTO sync_jobs (source_id, outcome, received, created, updated, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(job.sourceId, job.outcome, job.received, job.created, job.updated, job.error, job.startedAt, job.finishedAt);
        return { ...job, id: Number(info.lastInsertRowid) };
    }
    async latest(sourceId) {
        const r = this.db.prepare('SELECT * FROM sync_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId);
        return r ? this.toJob(r) : undefined;
    }
    async all(sourceId) {
        const rows = sourceId === undefined
            ? this.db.prepare('SELECT * FROM sync_jobs ORDER BY id').all()
            : this.db.prepare('SELECT * FROM sync_jobs WHERE source_id = ? ORDER BY id').all(sourceId);
        return rows.map((r) => this.toJob(r));
    }
    async forUser(userId, query) {
        const rows = this.db
            .prepare(`SELECT j.* FROM sync_jobs j JOIN connected_sources s ON s.id = j.source_id
                WHERE s.user_id = ? AND (? IS NULL OR j.outcome = ?) ORDER BY j.id DESC LIMIT ? OFFSET ?`)
            .all(userId, query.outcome ?? null, query.outcome ?? null, query.limit, query.offset);
        return rows.map((r) => this.toJob(r));
    }
    async removeForSource(sourceId) {
        this.db.prepare('DELETE FROM sync_jobs WHERE source_id = ?').run(sourceId);
    }
}
//# sourceMappingURL=SqliteJobsProvider.js.map