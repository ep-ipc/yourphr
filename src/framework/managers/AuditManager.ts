/**
 * Audit (yourphr#614): the patient-visible access log — the one door to "who has looked at my
 * record". The doc's REQUIRED capability, with the deliberate divergence from ngdpbase: no Null
 * fallback, no booting with auditing silently off. A provider that is not healthy fails
 * initialize(), and a write that cannot be kept throws — a listed read that could not be logged
 * fails rather than completing unlogged ("an unaudited disclosure did not happen").
 */
import { BaseManager, type BackupData } from '../BaseManager.js';
import type { Engine } from '../Engine.js';
import { ApiError, type ApiContext } from '../ApiContext.js';
import type { AccessEvent, BaseAuditProvider } from '../providers/BaseAuditProvider.js';

declare module '../Engine.js' {
  interface ManagerRegistry {
    audit: AuditManager;
  }
}

export type { AccessEvent };

export class AuditManager extends BaseManager {
  readonly name = 'audit';
  override readonly dependsOn = [] as const;

  constructor(engine: Engine, private readonly provider: BaseAuditProvider) {
    super(engine);
  }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await super.initialize(config);
    await this.provider.initialize();
    if (!(await this.provider.healthCheck())) {
      throw new Error('audit: the audit provider failed its health check — refusing to boot with auditing off');
    }
  }

  /**
   * One access of the caller's record. The owner is the caller; the actor is who actually asked —
   * a member for themselves, or a named system principal acting for them (recorded by its name).
   */
  async record(ctx: ApiContext, category: string, at = new Date()): Promise<void> {
    ctx.requireAuthenticated();
    if (category.trim() === '') throw new ApiError(400, 'an access needs a category');
    await this.provider.record(ctx.username, ctx.actor, category, at);
  }

  /** The caller's own log, newest day first. */
  async list(ctx: ApiContext): Promise<AccessEvent[]> {
    ctx.requireAuthenticated();
    return this.provider.list(ctx.username);
  }

  /** Buckets recorded elsewhere, for the account the migration principal acts for; an existing bucket is kept. */
  async importLegacy(ctx: ApiContext, events: AccessEvent[]): Promise<{ imported: number; skipped: number }> {
    if (ctx.system === '') throw new ApiError(403, 'legacy import is the migration tool\'s alone');
    let imported = 0;
    let skipped = 0;
    for (const e of events) {
      if (await this.provider.importEvent(ctx.username, e)) imported++;
      else skipped++;
    }
    return { imported, skipped };
  }

  /** Account deletion: the log goes with everything else the account owns. */
  async removeForUser(ctx: ApiContext): Promise<void> {
    ctx.requireAuthenticated();
    await this.provider.removeForOwner(ctx.username);
  }

  /** The log lives in the app database, which the backup coordinator copies whole. */
  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* restored with the app database */ }
}
