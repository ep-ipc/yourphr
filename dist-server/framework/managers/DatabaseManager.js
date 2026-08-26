/**
 * Database (yourphr#617): the engine's ownership of the application database's one connection.
 * Registered first so its shutdown() runs last — every sibling provider's handle is this one.
 * Backup of the app database rides with the PHI store's export (the component holding the key
 * exports; the app database is carried alongside), so this manager's own backup() says so.
 */
import { BaseManager } from '../BaseManager.js';
export class DatabaseManager extends BaseManager {
    provider;
    name = 'database';
    dependsOn = ['configuration'];
    constructor(engine, provider) {
        super(engine);
        this.provider = provider;
    }
    /** For the composition root only: the connection the sibling providers are built over. */
    get handle() { return this.provider.handle; }
    async initialize(config = {}) {
        await super.initialize(config);
        await this.provider.initialize();
        if (!(await this.provider.integrityOk()))
            throw new Error('database: the application database failed its integrity check — refusing to boot');
    }
    integrityOk() { return this.provider.integrityOk(); }
    /** The admin's Database card: where the app database lives and its size. */
    storage(ctx) {
        ctx.require('admin-read');
        return this.provider.storage();
    }
    async shutdown() {
        await this.provider.close();
        await super.shutdown();
    }
    async backup() {
        return { manager: this.name, takenAt: new Date().toISOString() };
    }
    async restore() { }
}
//# sourceMappingURL=DatabaseManager.js.map