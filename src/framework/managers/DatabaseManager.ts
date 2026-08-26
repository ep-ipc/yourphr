/**
 * Database (yourphr#617): the engine's ownership of the application database's one connection.
 * Registered first so its shutdown() runs last — every sibling provider's handle is this one.
 * Backup of the app database rides with the PHI store's export (the component holding the key
 * exports; the app database is carried alongside), so this manager's own backup() says so.
 */
import { BaseManager, type BackupData } from '../BaseManager.js';
import type { Engine } from '../Engine.js';
import type { ApiContext } from '../ApiContext.js';
import type { BaseDatabaseProvider } from '../providers/BaseDatabaseProvider.js';

declare module '../Engine.js' {
  interface ManagerRegistry {
    database: DatabaseManager;
  }
}

export class DatabaseManager<Handle = unknown> extends BaseManager {
  readonly name = 'database';
  override readonly dependsOn = ['configuration'] as const;

  constructor(engine: Engine, private readonly provider: BaseDatabaseProvider<Handle>) {
    super(engine);
  }

  /** For the composition root only: the connection the sibling providers are built over. */
  get handle(): Handle { return this.provider.handle; }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await super.initialize(config);
    await this.provider.initialize();
    if (!(await this.provider.integrityOk())) throw new Error('database: the application database failed its integrity check — refusing to boot');
  }

  integrityOk(): Promise<boolean> { return this.provider.integrityOk(); }

  /** The admin's Database card: where the app database lives and its size. */
  storage(ctx: ApiContext): { location: string; sizeBytes: number } {
    ctx.require('admin-read');
    return this.provider.storage();
  }

  override async shutdown(): Promise<void> {
    await this.provider.close();
    await super.shutdown();
  }

  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* staged with the PHI store's restore and applied at the next start */ }
}
