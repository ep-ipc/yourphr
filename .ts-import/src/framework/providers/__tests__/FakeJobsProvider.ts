/** An in-memory jobs provider for the manager specs. `ownerOf` stands in for the sources join. */
import { BaseJobsProvider, type JobRecord } from '../BaseJobsProvider.js';

export class FakeJobsProvider extends BaseJobsProvider {
  rows: JobRecord[] = [];
  initialized = false;
  constructor(private readonly ownerOf: (sourceId: number) => string | undefined = () => undefined) { super(); }
  async initialize(): Promise<void> { this.initialized = true; }
  async record(job: JobRecord): Promise<JobRecord> {
    const stored = { ...job, id: this.rows.length + 1 };
    this.rows.push(stored);
    return stored;
  }
  async latest(sourceId: number): Promise<JobRecord | undefined> { return [...this.rows].reverse().find((j) => j.sourceId === sourceId); }
  async all(sourceId?: number): Promise<JobRecord[]> { return this.rows.filter((j) => sourceId === undefined || j.sourceId === sourceId); }
  async forUser(userId: string, query: { limit: number; offset: number; outcome?: 'success' | 'failure' }): Promise<JobRecord[]> {
    return [...this.rows].reverse()
      .filter((j) => this.ownerOf(j.sourceId) === userId && (query.outcome === undefined || j.outcome === query.outcome))
      .slice(query.offset, query.offset + query.limit);
  }
  async removeForSource(sourceId: number): Promise<void> { this.rows = this.rows.filter((j) => j.sourceId !== sourceId); }
}
