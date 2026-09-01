/**
 * Agent tokens (yourphr#695): a credential a patient mints for themselves and hands to an agent —
 * an AI client, a script — so it can read their records on their behalf.
 *
 * Adopted from ngdpbase's `AgentTokenManager` (its #946), and specifically from the version AFTER
 * its #1108 review: porting the original would have carried eight defects into a PHI store. The
 * three rules that review produced are invariants here, not style:
 *
 *  1. **An unreadable date means expired, everywhere.** `Date.parse` answers NaN for a malformed
 *     value, and `NaN <= now` and `NaN > now` are BOTH false — so a naive verify reads a broken
 *     expiry as valid while a naive listing reads the same row as not-live. That combination is a
 *     token that authenticates forever and appears in no list, not even an admin's. Every
 *     comparison goes through `expiryMs()`, which collapses unparseable to -Infinity.
 *  2. **Nothing hands out a live reference to a stored record**, and nothing hands out the hash.
 *     `AgentTokenView` has no `hash` field, so it cannot leak by being forgotten.
 *  3. **Limits cannot be disabled by a typo.** `Number('24h')` is NaN and `ttl > NaN` is false, so
 *     an unvalidated config value silently removes the ceiling. `positiveInt()` falls back.
 *
 * ## What this stack does differently from ngdpbase, and why
 *
 * **Scopes are ACCESS CATEGORIES, not permission names.** ngdpbase's scopes are action names
 * (`page-create`) because it has actions to name. Here the `user` role holds no permissions at all
 * — a person's reach into their own records is compartmentalised by `user_id`, not gated by a
 * permission — so there was nothing for a scope to narrow. The access log's categories already
 * enumerate every read surface in patient-legible words, so they are the vocabulary: one list
 * decides what an agent may read, what the log calls it, and what the minting screen shows.
 *
 * The consequence is the safety property: **a surface that cannot be logged cannot be scoped.** An
 * agent can never reach a read the patient would not see recorded, because the same map answers
 * both questions. It also makes the first cut read-only structurally rather than by a flag — only
 * listed GETs have a category, so no write has a scope to be granted.
 *
 * **Minting, renewing and revoking need the OWNER'S SESSION.** An agent token can do none of them,
 * including to itself. A delegation that can extend its own life is not delegated any more, and a
 * 24-hour cap a token can lift is a cap on paper only.
 *
 * **Renewal re-mints rather than moving a date.** A leaked secret then dies at its original expiry
 * whatever the owner does afterwards.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BaseManager, type BackupData } from '../BaseManager.js';
import type { Engine } from '../Engine.js';
import { ApiError, type ApiContext } from '../ApiContext.js';
import { ACCESS_CATEGORIES, isAccessCategory } from '../../account/index.js';
import type { AgentTokenRecord, BaseAgentTokensProvider } from '../providers/BaseAgentTokensProvider.js';

declare module '../Engine.js' {
  interface ManagerRegistry {
    agentTokens: AgentTokensManager;
  }
}

/**
 * Prefix — makes a leaked token greppable, and scanner-matchable if one ever reaches a repository.
 * The host-bound value ngdpbase isolates for the same reason; theirs is `ngdp_at_`.
 */
export const TOKEN_PREFIX = 'yphr_at_';
const CONFIG_PREFIX = 'yourphr.auth.agent-token';
const TOKEN_BYTES = 32;

/** What a caller may see: everything the record holds except the hash. */
export type AgentTokenView = Omit<AgentTokenRecord, 'hash'> & {
  /** Whole seconds until expiry; 0 once dead. What the account page shows beside revoke. */
  expiresInSeconds: number;
  live: boolean;
};

export interface AgentTokenPolicy {
  enabled: boolean;
  readOnly: boolean;
  defaultTtlHours: number;
  maxTtlHours: number;
  maxPerUser: number;
  retentionDays: number;
  renewable: boolean;
  /** 0 = unlimited. */
  maxRenewals: number;
  renewWindowHours: number;
}

export const DefaultAgentTokenPolicy: AgentTokenPolicy = {
  enabled: false,
  readOnly: true,
  defaultTtlHours: 24,
  maxTtlHours: 24,
  maxPerUser: 10,
  retentionDays: 30,
  renewable: true,
  maxRenewals: 0,
  renewWindowHours: 6,
};

const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** Constant-time compare of two equal-length hash strings. */
function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Expiry in milliseconds, where **unparseable means expired**. See invariant 1 in the file header;
 * this single function is what keeps the verify path and the listing path agreeing about a broken
 * row instead of disagreeing in the one direction that hides a live credential.
 */
function expiryMs(record: Pick<AgentTokenRecord, 'expiresAt'>): number {
  const parsed = Date.parse(record.expiresAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** A configured number, or the fallback when it is not a usable one. See invariant 3. */
function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class AgentTokensManager extends BaseManager {
  readonly name = 'agentTokens' as const;
  // Configuration, not users: the policy is read at initialize, and an owner is a string this
  // manager stores rather than an account it resolves.
  override readonly dependsOn = ['configuration'] as const;

  private policy: AgentTokenPolicy = { ...DefaultAgentTokenPolicy };

  constructor(engine: Engine, private readonly provider: BaseAgentTokensProvider) {
    super(engine);
  }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await super.initialize(config);
    await this.provider.initialize();

    const cfg = this.engine.managers.configuration;
    const num = (key: string, fallback: number): number => positiveInt(cfg.getInt(`${CONFIG_PREFIX}.${key}`), fallback);
    this.policy = {
      enabled: cfg.getBool(`${CONFIG_PREFIX}.enabled`),
      readOnly: cfg.getBool(`${CONFIG_PREFIX}.read-only`),
      defaultTtlHours: num('default-ttl-hours', DefaultAgentTokenPolicy.defaultTtlHours),
      maxTtlHours: num('max-ttl-hours', DefaultAgentTokenPolicy.maxTtlHours),
      maxPerUser: num('max-per-user', DefaultAgentTokenPolicy.maxPerUser),
      retentionDays: num('retention-days', DefaultAgentTokenPolicy.retentionDays),
      renewable: cfg.getBool(`${CONFIG_PREFIX}.renewable`),
      // 0 is a MEANING here (unlimited), not a typo, so it cannot go through positiveInt.
      maxRenewals: Math.max(0, Math.trunc(Number(cfg.getInt(`${CONFIG_PREFIX}.max-renewals`)) || 0)),
      renewWindowHours: num('renew-window-hours', DefaultAgentTokenPolicy.renewWindowHours),
    };

    // Dead records go on every boot, as ngdpbase does — but unlike ngdpbase (its #1108) this is
    // not the only time it happens: purge also runs on each mint, so a long-lived process still
    // applies its own retention policy.
    await this.purgeExpired();
  }

  get settings(): AgentTokenPolicy { return { ...this.policy }; }

  /** The scope vocabulary a minting screen offers. */
  get availableScopes(): readonly string[] { return ACCESS_CATEGORIES; }

  /**
   * The gate on every management call: a HUMAN session, never an agent token.
   *
   * This is the rule that keeps the TTL cap real. Without it a token could renew itself and a
   * 24-hour credential becomes permanent — which is precisely why ngdpbase shipped no renew at all
   * rather than shipping one that a token could reach.
   */
  private requireHuman(ctx: ApiContext): void {
    ctx.requireAuthenticated();
    if (ctx.viaToken || ctx.viaDevice) {
      throw new ApiError(403, 'an agent token cannot manage agent tokens — sign in to do this');
    }
  }

  private requireEnabled(): void {
    if (!this.policy.enabled) {
      throw new ApiError(404, 'agent tokens are not enabled on this instance');
    }
  }

  /**
   * Mint a token for the caller. The cleartext is returned ONCE and never stored.
   */
  async mint(
    ctx: ApiContext,
    name: string,
    scopes: string[],
    ttlHours?: number,
    now: number = Date.now()
  ): Promise<{ token: string; record: AgentTokenView }> {
    this.requireEnabled();
    this.requireHuman(ctx);
    return this.issue(ctx.username, name, scopes, ttlHours, now, { renewals: 0, renewedFrom: '' });
  }

  /** The shared minting path — a fresh mint and a renewal differ only in provenance. */
  private async issue(
    owner: string,
    name: string,
    scopes: string[],
    ttlHours: number | undefined,
    now: number,
    lineage: { renewals: number; renewedFrom: string }
  ): Promise<{ token: string; record: AgentTokenView }> {
    const label = String(name ?? '').trim();
    if (label === '') throw new ApiError(400, 'a token needs a name — it is what the access log will call the agent');
    if (label.length > 60) throw new ApiError(400, 'a token name is at most 60 characters');

    // An unscoped token is REFUSED, never treated as unrestricted (ngdpbase #946's decision, and
    // the difference between this and the Go token it replaces, which scoped to the whole account).
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new ApiError(400, 'choose at least one thing this agent may read');
    }
    if (!scopes.every((s) => typeof s === 'string')) {
      throw new ApiError(400, 'every scope must be a string');
    }
    const wanted = [...new Set(scopes.map((s) => s.trim()))];
    const unknown = wanted.filter((s) => !isAccessCategory(s));
    if (unknown.length > 0) {
      // Named rather than dropped: silently ignoring an unknown scope mints a token that reads
      // less than the patient was told it would, which they discover as a broken agent.
      throw new ApiError(400, `not something this instance can share: ${unknown.join(', ')}`);
    }

    const ttl = positiveInt(ttlHours ?? this.policy.defaultTtlHours, 0);
    if (ttl === 0) throw new ApiError(400, 'ttlHours must be a positive number');
    if (ttl > this.policy.maxTtlHours) {
      throw new ApiError(400, `a token may last at most ${this.policy.maxTtlHours} hours`);
    }

    // Retention runs here as well as at boot, so a process that stays up for months still applies it.
    await this.purgeExpired(now);

    const live = await this.provider.countLiveForOwner(owner, new Date(now).toISOString());
    if (live >= this.policy.maxPerUser) {
      throw new ApiError(409, `you already have ${this.policy.maxPerUser} live tokens — revoke one first`);
    }

    const secret = randomBytes(TOKEN_BYTES).toString('base64url');
    const token = `${TOKEN_PREFIX}${secret}`;
    const record: AgentTokenRecord = {
      id: `tok_${randomBytes(8).toString('hex')}`,
      owner,
      name: label,
      hash: sha256(token),
      prefix: token.slice(0, TOKEN_PREFIX.length + 4),
      scopes: wanted,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 3_600_000).toISOString(),
      lastUsedAt: '',
      revokedAt: '',
      revokedBy: '',
      renewals: lineage.renewals,
      renewedFrom: lineage.renewedFrom,
    };
    await this.provider.create(record);
    return { token, record: this.toView(record, now) };
  }

  /**
   * Verify a presented cleartext token. Answers the record when it is live, else undefined.
   *
   * Stamps `last_used_at`. Unlike ngdpbase this writes on the read path rather than buffering: the
   * defect its #1108 fixed was `persist()` taking a hash-bearing BACKUP COPY per request, not the
   * update itself, and there is no such copy here — the store is the app database, which the
   * backup coordinator handles whole. One indexed UPDATE also matches what this stack already does
   * per read, since the access log writes a row before serving.
   */
  async verify(token: string, now: number = Date.now()): Promise<AgentTokenRecord | undefined> {
    if (!this.policy.enabled) return undefined;
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return undefined;

    const stored = await this.provider.findByHash(sha256(token));
    if (!stored) return undefined;
    // Constant-time even though the lookup was by equality: the comparison is the assertion, and
    // it costs nothing to make the assertion the one that decides.
    if (!hashEquals(stored.hash, sha256(token))) return undefined;

    if (stored.revokedAt !== '') return undefined;
    if (expiryMs(stored) <= now) return undefined;
    if (stored.scopes.length === 0) return undefined; // a corrupt row reads nothing (see the provider)

    await this.provider.touch(stored.id, new Date(now).toISOString());
    return { ...stored, scopes: [...stored.scopes] };
  }

  /** The caller's own tokens, newest first — live ones and recent dead ones alike. */
  async listForOwner(ctx: ApiContext, now: number = Date.now()): Promise<AgentTokenView[]> {
    this.requireEnabled();
    this.requireHuman(ctx);
    return (await this.provider.listForOwner(ctx.username)).map((r) => this.toView(r, now));
  }

  /** Every token on the instance, for the operator screen. */
  async listAll(ctx: ApiContext, now: number = Date.now()): Promise<AgentTokenView[]> {
    this.requireEnabled();
    ctx.require('admin-read');
    return (await this.provider.listAll()).map((r) => this.toView(r, now));
  }

  /**
   * Rotate a live token forward: a NEW secret, the same name and scopes, the old record revoked.
   *
   * Deliberately not "move expiresAt". A secret that has leaked dies at its original expiry
   * however many times the owner renews, and the access log keeps a continuous agent name across
   * the rotation because the name carries.
   */
  async renew(ctx: ApiContext, id: string, now: number = Date.now()): Promise<{ token: string; record: AgentTokenView }> {
    this.requireEnabled();
    this.requireHuman(ctx);
    if (!this.policy.renewable) throw new ApiError(403, 'tokens cannot be renewed on this instance');

    const existing = await this.provider.get(id);
    // Same answer for "not yours" as for "does not exist": a distinguishable 403 would let one
    // account probe for another's token ids.
    if (!existing || existing.owner !== ctx.username) throw new ApiError(404, 'no such token');
    if (existing.revokedAt !== '') throw new ApiError(409, 'that token has been revoked');
    const expiry = expiryMs(existing);
    if (expiry <= now) throw new ApiError(409, 'that token has expired — mint a new one');

    if (this.policy.maxRenewals > 0 && existing.renewals >= this.policy.maxRenewals) {
      throw new ApiError(409, `that token has been renewed ${existing.renewals} times — mint a new one`);
    }
    // Only near expiry. Without this, "renew" is a button pressed on day one and the life is
    // unbounded from the start; renewing late keeps each extension a recent, deliberate decision.
    const windowOpensAt = expiry - this.policy.renewWindowHours * 3_600_000;
    if (now < windowOpensAt) {
      throw new ApiError(409, `that token can be renewed within ${this.policy.renewWindowHours} hours of expiring`);
    }

    const issued = await this.issue(existing.owner, existing.name, existing.scopes, undefined, now, {
      renewals: existing.renewals + 1,
      renewedFrom: existing.id,
    });
    // The old record stays as revoked until retention drops it, so the rotation is visible.
    await this.provider.revoke(existing.id, new Date(now).toISOString(), ctx.username);
    return issued;
  }

  /** Withdraw a token now. Effective on the next request — verification reads the store. */
  async revoke(ctx: ApiContext, id: string, now: number = Date.now()): Promise<boolean> {
    this.requireEnabled();
    this.requireHuman(ctx);
    const existing = await this.provider.get(id);
    if (!existing || existing.owner !== ctx.username) throw new ApiError(404, 'no such token');
    return this.provider.revoke(id, new Date(now).toISOString(), ctx.username);
  }

  /** Drop dead records past the retention window. */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    const cutoff = new Date(now - this.policy.retentionDays * 86_400_000).toISOString();
    return this.provider.purge(cutoff);
  }

  /** Account deletion: an account's tokens go with everything else it owns. */
  async removeForUser(ctx: ApiContext): Promise<void> {
    ctx.requireAuthenticated();
    await this.provider.removeForOwner(ctx.username);
  }

  private toView(record: AgentTokenRecord, now: number): AgentTokenView {
    const { hash: _hash, ...rest } = record;
    const expiry = expiryMs(record);
    const live = record.revokedAt === '' && expiry > now;
    return {
      ...rest,
      scopes: [...record.scopes],
      live,
      expiresInSeconds: live ? Math.max(0, Math.floor((expiry - now) / 1000)) : 0,
    };
  }

  /** The tokens live in the app database, which the backup coordinator copies whole. */
  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* restored with the app database */ }
}
