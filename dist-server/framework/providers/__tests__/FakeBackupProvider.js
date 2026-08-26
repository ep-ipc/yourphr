/** An in-memory backup store for the manager specs: artifacts by destination, a scriptable writability. */
import { BaseBackupProvider } from '../BaseBackupProvider.js';
export class FakeBackupProvider extends BaseBackupProvider {
    name = 'fake';
    initialized = false;
    prepared = [];
    artifacts = new Map();
    writable = true;
    async initialize() { this.initialized = true; }
    async ensure(destination) {
        if (!this.writable)
            throw new Error(`cannot create ${destination}: read-only file system`);
        this.prepared.push(destination);
    }
    /** What the exporter "wrote" — the spec adds artifacts as the fake exporter reports them. */
    add(destination, name, sizeBytes = 10) {
        const list = this.artifacts.get(destination) ?? [];
        list.unshift({ name, sizeBytes, modified: `2026-01-01T00:00:00.000Z` });
        this.artifacts.set(destination, list);
    }
    async list(destination) { return [...(this.artifacts.get(destination) ?? [])]; }
    async resolve(destination, name) {
        return (this.artifacts.get(destination) ?? []).some((a) => a.name === name) ? `${destination}/${name}` : undefined;
    }
    async prune(destination, keep) {
        if (keep <= 0)
            return [];
        const list = this.artifacts.get(destination) ?? [];
        const pruned = list.splice(keep).map((a) => a.name);
        return pruned;
    }
    async testDestination(destination) {
        return this.writable ? { destination, writable: true } : { destination, writable: false, error: 'read-only file system' };
    }
    async browse(path) {
        if (path === '/nope')
            throw new Error('cannot read "/nope": not a directory');
        return { path, parent: path === '/' ? '' : '/', dirs: ['a', 'b'] };
    }
}
//# sourceMappingURL=FakeBackupProvider.js.map