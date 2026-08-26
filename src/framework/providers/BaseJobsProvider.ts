/** Background-job history (yourphr#612): one row per finished run. Framework: every application has jobs. */
export interface JobRecord {
  id?: number;
  /** The resource the job ran for — here a connected source's numeric id. */
  sourceId: number;
  outcome: 'success' | 'failure';
  received: number;
  created: number;
  updated: number;
  error: string;
  startedAt: number;
  finishedAt: number;
}

export abstract class BaseJobsProvider {
  abstract initialize(): Promise<void>;
  abstract record(job: JobRecord): Promise<JobRecord>;
  abstract latest(sourceId: number): Promise<JobRecord | undefined>;
  abstract all(sourceId?: number): Promise<JobRecord[]>;
  /** The jobs of the sources one account owns, newest first — the join is the provider's. */
  abstract forUser(userId: string, query: { limit: number; offset: number; outcome?: 'success' | 'failure' }): Promise<JobRecord[]>;
  abstract removeForSource(sourceId: number): Promise<void>;
}
