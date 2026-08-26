/** An in-memory audit provider for the manager specs; `healthy`/`failWrites` script the refusals. */
import { BaseAuditProvider } from '../BaseAuditProvider.js';
export class FakeAuditProvider extends BaseAuditProvider {
    rows = new Map();
    initialized = false;
    healthy = true;
    failWrites = false;
    async initialize() { this.initialized = true; }
    async healthCheck() { return this.healthy; }
    key(owner, actor, category, day) { return `${owner}|${actor}|${category}|${day}`; }
    async record(owner, actor, category, at) {
        if (this.failWrites)
            throw new Error('audit sink unavailable');
        const iso = at.toISOString();
        const day = iso.slice(0, 10);
        const k = this.key(owner, actor, category, day);
        const r = this.rows.get(k);
        if (r) {
            r.count++;
            r.last_at = iso;
        }
        else
            this.rows.set(k, { owner, actor_username: actor, category, day, count: 1, first_at: iso, last_at: iso });
    }
    async importEvent(owner, e) {
        const k = this.key(owner, e.actor_username, e.category, e.day);
        if (this.rows.has(k))
            return false;
        this.rows.set(k, { owner, ...e });
        return true;
    }
    async list(owner) {
        return [...this.rows.values()].filter((r) => r.owner === owner).sort((a, b) => b.day.localeCompare(a.day) || b.last_at.localeCompare(a.last_at) || a.category.localeCompare(b.category))
            .map(({ owner: _o, ...e }) => e);
    }
    async removeForOwner(owner) { for (const [k, r] of this.rows)
        if (r.owner === owner)
            this.rows.delete(k); }
}
//# sourceMappingURL=FakeAuditProvider.js.map