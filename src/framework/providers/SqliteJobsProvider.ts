/** The sync_jobs table in the app database (yourphr#612). */
import type Database from 'better-sqlite3-multiple-ciphers';
import { BaseJobsProvider, type JobRecord } from './BaseJobsProvider.js';

export class SqliteJobsProvider extends BaseJobsProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
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

  async initialize(): Promise<void> { /* schema ensured in the constructor */ }

  private toJob(r: Record<string, unknown>): JobRecord {
    return { id: r['id'] as number, sourceId: r['source_id'] as number, outcome: r['outcome'] as 'success' | 'failure', received: r['received'] as number, created: r['created'] as number, updated: r['updated'] as number, error: r['error'] as string, startedAt: r['started_at'] as number, finishedAt: r['finished_at'] as number };
  }

  async record(job: JobRecord): Promise<JobRecord> {
    const info = this.db
      .prepare('INSERT INTO sync_jobs (source_id, outcome, received, created, updated, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(job.sourceId, job.outcome, job.received, job.created, job.updated, job.error, job.startedAt, job.finishedAt);
    return { ...job, id: Number(info.lastInsertRowid) };
  }

  async latest(sourceId: number): Promise<JobRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM sync_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as Record<string, unknown> | undefined;
    return r ? this.toJob(r) : undefined;
  }

  async all(sourceId?: number): Promise<JobRecord[]> {
    const rows = sourceId === undefined
      ? this.db.prepare('SELECT * FROM sync_jobs ORDER BY id').all()
      : this.db.prepare('SELECT * FROM sync_jobs WHERE source_id = ? ORDER BY id').all(sourceId);
    return (rows as Record<string, unknown>[]).map((r) => this.toJob(r));
  }

  async forUser(userId: string, query: { limit: number; offset: number; outcome?: 'success' | 'failure' }): Promise<JobRecord[]> {
    const rows = this.db
      .prepare(`SELECT j.* FROM sync_jobs j JOIN connected_sources s ON s.id = j.source_id
                WHERE s.user_id = ? AND (? IS NULL OR j.outcome = ?) ORDER BY j.id DESC LIMIT ? OFFSET ?`)
      .all(userId, query.outcome ?? null, query.outcome ?? null, query.limit, query.offset) as Record<string, unknown>[];
    return rows.map((r) => this.toJob(r));
  }

  async removeForSource(sourceId: number): Promise<void> {
    this.db.prepare('DELETE FROM sync_jobs WHERE source_id = ?').run(sourceId);
  }
}
