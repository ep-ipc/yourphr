/**
 * Jobs (yourphr#612): the history of background runs — the one door to sync_jobs. Framework, not
 * app: every application has jobs, and yourphr#441's lesson ("an invisible background job is
 * indistinguishable from a broken one") is not specific to health records. Records outcomes, never
 * a queue: a recorded job is DONE or FAILED, so Go's READY/LOCKED match nothing here.
 */
import { BaseManager } from '../BaseManager.js';
/**
 * A recorded job in the shape of Go's BackgroundJob + BackgroundJobSyncData (yourphr#593), which is
 * what the Angular shell and /background-jobs read. Only what the row holds: the job id is the row
 * id, the user is the caller (the ownership join proved it), brand_id is empty (no brand here).
 */
export function backgroundJobShape(job, username) {
    const iso = (seconds) => new Date(seconds * 1000).toISOString();
    const done = job.outcome === 'success';
    return {
        id: String(job.id ?? ''),
        created_at: iso(job.startedAt),
        updated_at: iso(job.finishedAt),
        user_id: username,
        job_type: 'SYNC',
        job_status: done ? 'STATUS_DONE' : 'STATUS_FAILED',
        locked_time: iso(job.startedAt),
        done_time: iso(job.finishedAt),
        retries: 0,
        data: {
            source_id: `source-${job.sourceId}`,
            brand_id: '',
            ...(job.error ? { error_data: { error: job.error } } : {}),
            summary: {
                outcome: done ? 'success' : 'failed',
                duration_ms: Math.max(0, job.finishedAt - job.startedAt) * 1000,
                total_resources: job.received,
                ...(job.error ? { error_message: job.error } : {}),
            },
        },
    };
}
export class JobsManager extends BaseManager {
    provider;
    name = 'jobs';
    dependsOn = [];
    constructor(engine, provider) {
        super(engine);
        this.provider = provider;
    }
    async initialize(config = {}) {
        await super.initialize(config);
        await this.provider.initialize();
    }
    /** Records a finished run. The caller is whoever ran it — a member syncing now, or the worker for them. */
    async record(ctx, job) {
        ctx.requireAuthenticated();
        return this.provider.record(job);
    }
    /** The newest run of one source — the `latest_background_job` a source carries. */
    latest(sourceId) {
        return this.provider.latest(sourceId);
    }
    /** Every run of one source, oldest first — what the harnesses and an operator read. */
    history(sourceId) {
        return this.provider.all(sourceId);
    }
    /**
     * The caller's jobs, newest first, in Go's shape with Go's filters honestly mapped (yourphr#593):
     * SYNC is the only job type here; STATUS_DONE/STATUS_FAILED the only statuses a recorded job can
     * have, so any other filter matches nothing rather than something.
     */
    async forUser(ctx, query) {
        ctx.requireAuthenticated();
        if (query.jobType && query.jobType !== 'SYNC')
            return [];
        let outcome;
        if (query.status === 'STATUS_DONE')
            outcome = 'success';
        else if (query.status === 'STATUS_FAILED')
            outcome = 'failure';
        else if (query.status)
            return [];
        const jobs = await this.provider.forUser(ctx.username, { limit: query.limit, offset: query.page * query.limit, outcome });
        return jobs.map((job) => backgroundJobShape(job, ctx.username));
    }
    /** Every run, newest first — an operator's view (yourphr#593 metrics). */
    async all(ctx) {
        ctx.require('admin-read');
        return (await this.provider.all()).reverse();
    }
    /** A source's history goes with the source. */
    removeForSource(sourceId) {
        return this.provider.removeForSource(sourceId);
    }
    /** Job history lives in the app database, which the backup coordinator copies whole; nothing separate to take. */
    async backup() {
        return { manager: this.name, takenAt: new Date().toISOString() };
    }
    async restore() { }
}
//# sourceMappingURL=JobsManager.js.map