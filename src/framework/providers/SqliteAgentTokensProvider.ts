/**
 * The agent_tokens table in the app database (yourphr#695). Every raw query over it lives here.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { BaseAgentTokensProvider, type AgentTokenRecord } from './BaseAgentTokensProvider.js';

/**
 * The table as the provider creates it on a fresh database. The app migration that adds it
 * (src/app.ts, 20260828140000) carries a frozen copy — keep this one current and that one
 * untouched.
 *
 * `hash` is UNIQUE: two rows sharing one hash would make verification's answer depend on row
 * order. It cannot happen from 256 bits of randomness, which is exactly why the database should
 * say so rather than trust it.
 */
export const AGENT_TOKENS_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  revoked_by TEXT NOT NULL DEFAULT '',
  renewals INTEGER NOT NULL DEFAULT 0,
  renewed_from TEXT NOT NULL DEFAULT ''
)`;

const INDEXES = [
  // The verification lookup, on every agent request.
  `CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(hash)`,
  // The account page's list, and the per-owner live count the mint cap reads.
  `CREATE INDEX IF NOT EXISTS idx_agent_tokens_owner ON agent_tokens(owner, created_at DESC)`,
];

interface Row {
  id: string; owner: string; name: string; hash: string; prefix: string; scopes: string;
  created_at: string; expires_at: string; last_used_at: string; revoked_at: string;
  revoked_by: string; renewals: number; renewed_from: string;
}

export class SqliteAgentTokensProvider extends BaseAgentTokensProvider {
  constructor(private readonly db: InstanceType<typeof Database>) {
    super();
    db.exec(AGENT_TOKENS_SCHEMA);
    for (const sql of INDEXES) db.exec(sql);
  }

  async initialize(): Promise<void> { /* schema ensured in the constructor, like the users provider */ }

  /**
   * Scopes are stored as JSON, and a row that cannot be parsed yields NO scopes.
   *
   * Failing to the empty list is the safe direction and is load-bearing: the manager treats an
   * empty scope list as "may read nothing", never as "unrestricted", so a corrupt row disables the
   * token instead of widening it.
   */
  private toRecord(r: Row): AgentTokenRecord {
    let scopes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.scopes);
      if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      scopes = [];
    }
    return {
      id: r.id, owner: r.owner, name: r.name, hash: r.hash, prefix: r.prefix, scopes,
      createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at, revokedBy: r.revoked_by,
      renewals: r.renewals, renewedFrom: r.renewed_from,
    };
  }

  async create(record: AgentTokenRecord): Promise<void> {
    this.db.prepare(`INSERT INTO agent_tokens
      (id, owner, name, hash, prefix, scopes, created_at, expires_at, last_used_at, revoked_at, revoked_by, renewals, renewed_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.owner, record.name, record.hash, record.prefix, JSON.stringify(record.scopes),
        record.createdAt, record.expiresAt, record.lastUsedAt, record.revokedAt, record.revokedBy,
        record.renewals, record.renewedFrom);
  }

  async findByHash(hash: string): Promise<AgentTokenRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM agent_tokens WHERE hash = ?').get(hash) as Row | undefined;
    return r ? this.toRecord(r) : undefined;
  }

  async get(id: string): Promise<AgentTokenRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toRecord(r) : undefined;
  }

  async listForOwner(owner: string): Promise<AgentTokenRecord[]> {
    return (this.db.prepare('SELECT * FROM agent_tokens WHERE owner = ? ORDER BY created_at DESC, id').all(owner) as Row[])
      .map((r) => this.toRecord(r));
  }

  async listAll(): Promise<AgentTokenRecord[]> {
    return (this.db.prepare('SELECT * FROM agent_tokens ORDER BY created_at DESC, id').all() as Row[])
      .map((r) => this.toRecord(r));
  }

  /**
   * Live = not revoked and not yet expired. The comparison is on ISO strings, which sorts
   * correctly because every timestamp written here is UTC with the same precision.
   */
  async countLiveForOwner(owner: string, nowIso: string): Promise<number> {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM agent_tokens WHERE owner = ? AND revoked_at = '' AND expires_at > ?`
    ).get(owner, nowIso) as { n: number }).n;
  }

  async touch(id: string, lastUsedAt: string): Promise<void> {
    this.db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').run(lastUsedAt, id);
  }

  async revoke(id: string, revokedAt: string, revokedBy: string): Promise<boolean> {
    return this.db.prepare(`UPDATE agent_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at = ''`)
      .run(revokedAt, revokedBy, id).changes === 1;
  }

  async purge(deadBeforeIso: string): Promise<number> {
    // Dead is revoked OR expired; the cutoff applies to whichever ended it. A revoked token that
    // had not yet expired is dead from its revocation, not from its original expiry.
    return this.db.prepare(
      `DELETE FROM agent_tokens
       WHERE (revoked_at != '' AND revoked_at <= ?)
          OR (revoked_at = '' AND expires_at <= ?)`
    ).run(deadBeforeIso, deadBeforeIso).changes;
  }

  async removeForOwner(owner: string): Promise<void> {
    this.db.prepare('DELETE FROM agent_tokens WHERE owner = ?').run(owner);
  }
}
