export class BaseBackupProvider {
}
export class NullBackupProvider extends BaseBackupProvider {
    name = 'null';
    refuse() {
        throw new Error('no backup storage is configured (backup.storage.provider = null): backups cannot be written, listed or restored');
    }
    async initialize() { }
    async ensure() { this.refuse(); }
    async list() { return []; }
    async resolve() { return undefined; }
    async prune() { return []; }
    async testDestination(destination) {
        return { destination, writable: false, error: 'no backup storage is configured (backup.storage.provider = null)' };
    }
    async browse() { this.refuse(); }
}
//# sourceMappingURL=BaseBackupProvider.js.map