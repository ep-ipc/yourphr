/** An in-memory jobs provider for the manager specs. `ownerOf` stands in for the sources join. */
import { BaseJobsProvider } from '../BaseJobsProvider.js';
export class FakeJobsProvider extends BaseJobsProvider {
    ownerOf;
    rows = [];
    initialized = false;
    constructor(ownerOf = () => undefined) {
        super();
        this.ownerOf = ownerOf;
    }
    async initialize() { this.initialized = true; }
    async record(job) {
        const stored = { ...job, id: this.rows.length + 1 };
        this.rows.push(stored);
        return stored;
    }
    async latest(sourceId) { return [...this.rows].reverse().find((j) => j.sourceId === sourceId); }
    async all(sourceId) { return this.rows.filter((j) => sourceId === undefined || j.sourceId === sourceId); }
    async forUser(userId, query) {
        return [...this.rows].reverse()
            .filter((j) => this.ownerOf(j.sourceId) === userId && (query.outcome === undefined || j.outcome === query.outcome))
            .slice(query.offset, query.offset + query.limit);
    }
    async removeForSource(sourceId) { this.rows = this.rows.filter((j) => j.sourceId !== sourceId); }
}
//# sourceMappingURL=FakeJobsProvider.js.map