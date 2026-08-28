/**
 * Agent-token storage (yourphr#695): the table behind the AgentTokens manager.
 *
 * A capability an adopter could plausibly swap — ngdpbase keeps these in a JSON file at
 * `<FAST_STORAGE>/tokens/`; this stack has SQLite and a DatabaseManager, so they live there and
 * ride the existing encrypted backup rather than needing one of their own.
 *
 * The provider stores; the manager decides. In particular the provider never sees a cleartext
 * token — only the hash the manager computed — and never judges whether a record is live.
 */

export interface AgentTokenRecord {
  id: string;
  owner: string;
  /** What the patient called it — and what the access log names as the actor. */
  name: string;
  /** `sha256:<hex>`. Never the cleartext. */
  hash: string;
  /** Leading characters, for display in the token list. */
  prefix: string;
  /** Access categories this token may read (yourphr#695). Empty is never "everything". */
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string;
  revokedBy: string;
  /** How many times this token has been rotated forward; 0 for a fresh mint. */
  renewals: number;
  /** The id this token replaced, when it was minted by a renewal; '' otherwise. */
  renewedFrom: string;
}

/**
 * Empty string rather than null throughout, matching `legal_consent.accepted_at` and
 * `connected_sources.refresh_token` in this schema: SQLite's NULL handling is where yourphr#528
 * went wrong, and a column that is never NULL cannot repeat it.
 */
export abstract class BaseAgentTokensProvider {
  abstract initialize(): Promise<void>;
  abstract create(record: AgentTokenRecord): Promise<void>;
  /** By hash — the verification lookup. Returns whatever is stored, live or not; the manager judges. */
  abstract findByHash(hash: string): Promise<AgentTokenRecord | undefined>;
  abstract get(id: string): Promise<AgentTokenRecord | undefined>;
  /** Every record for an owner, newest first — including dead ones; the manager filters. */
  abstract listForOwner(owner: string): Promise<AgentTokenRecord[]>;
  abstract listAll(): Promise<AgentTokenRecord[]>;
  abstract countLiveForOwner(owner: string, nowIso: string): Promise<number>;
  abstract touch(id: string, lastUsedAt: string): Promise<void>;
  abstract revoke(id: string, revokedAt: string, revokedBy: string): Promise<boolean>;
  /** Drop dead records whose death is older than the cutoff. Returns how many went. */
  abstract purge(deadBeforeIso: string): Promise<number>;
  abstract removeForOwner(owner: string): Promise<void>;
}
