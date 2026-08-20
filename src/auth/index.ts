/**
 * Phase 3 of the TypeScript transition (yourphr#541): who is the caller?
 *
 * Per-user isolation was proven GIVEN a user id (yourphr#537); nothing established that identity.
 * This module is sign-in, sessions, revocation, throttling and the trusted-proxy answer — each
 * mirroring a decision the Go stack already paid to learn, with the issue that taught it:
 *
 *   - Sessions carry the user's token_generation and are refused when the account's counter has
 *     moved (yourphr#508) — so a password change ends a stolen session. The counter lives in the
 *     database, NOT the token, which is what makes revocation real (yourphr#528 is the cautionary
 *     tale of a counter that reported success and did nothing).
 *   - Sliding TTL with an absolute cap (yourphr#445): activity extends a session, but no amount of
 *     activity extends it past the cap.
 *   - Throttling per ACCOUNT and per IP (yourphr#509): per-IP alone misses a slow distributed
 *     attempt; per-account alone lets one household lock itself out.
 *   - The per-IP key is meaningless unless the proxy question is answered (yourphr#529):
 *     X-Forwarded-For is caller-controlled unless the direct peer is a declared trusted proxy.
 *   - Sign-in gives nothing away about whether an account exists (yourphr#104): one generic
 *     message, and the password verifier runs even for unknown users so timing does not answer
 *     the question either.
 *   - Password policy enforced server-side (yourphr#506).
 *
 * Password hashing is scrypt from node's standard library — the ngdpbase #1042 design: per-user
 * random salt, parameters carried in the stored value (`scrypt$N$r$p$salt$hash`) so cost can be
 * raised later and old hashes keep verifying, constant-time comparison. No dependency.
 *
 * Deliberately NOT here, recorded rather than silently absent (yourphr#541 acceptance):
 *   - bcrypt verification for accounts migrated from the Go stack (Go stores bcrypt cost-14; node
 *     has no stdlib bcrypt, so Phase 5 migration needs a bcrypt dependency plus rehash-on-login)
 *   - a durable throttle store (counters are in-memory; a restart clears them)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';

// ---------------------------------------------------------------------------
// Password hashing (scrypt, self-describing)

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(stored: string, password: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false; // unknown scheme (or the empty hash of an external account) never matches
  }
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64 as string, 'base64');
  const expected = Buffer.from(hashB64 as string, 'base64');
  const candidate = scryptSync(password, salt, expected.length, {
    N: Number(nStr), r: Number(rStr), p: Number(pStr),
  });
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// A real hash of a random password, verified for UNKNOWN usernames so a miss costs the same time
// as a wrong password (yourphr#104 — timing must not reveal whether the account exists).
const dummyHash = hashPassword(randomBytes(16).toString('base64url'));

// ---------------------------------------------------------------------------
// Session tokens: HMAC-SHA256 over a JSON payload, base64url(payload).base64url(mac).
// Deliberately not JWT: no algorithm agility to misconfigure ("alg":"none" has no equivalent here),
// one key, one scheme, and the whole verifier fits on a screen.

export interface SessionClaims {
  /** username */
  u: string;
  /** the account's token_generation at issue time (yourphr#508) */
  g: number;
  /** issued at, unix seconds */
  iat: number;
  /** sliding expiry, unix seconds — refreshed by activity (yourphr#445) */
  exp: number;
  /** absolute cap, unix seconds — never extended (yourphr#445) */
  cap: number;
}

export interface SessionPolicy {
  /** sliding window: a use inside this window is valid, and renews the window */
  slidingSeconds: number;
  /** absolute cap: no session outlives issue time + this, however active */
  absoluteSeconds: number;
}

export const DefaultSessionPolicy: SessionPolicy = { slidingSeconds: 60 * 60, absoluteSeconds: 12 * 60 * 60 };

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

export function issueToken(key: Buffer, claims: SessionClaims): string {
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${b64url(mac(key, payload))}`;
}

/** Signature + shape check only — expiry and generation are the store's job (verifySession). */
export function decodeToken(key: Buffer, token: string): SessionClaims | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const payload = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(key, payload);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof claims.u !== 'string' || typeof claims.g !== 'number' || typeof claims.exp !== 'number' || typeof claims.cap !== 'number') {
      return undefined;
    }
    return claims;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Throttle: fixed-size sliding windows per key, in memory (recorded limitation: not restart-durable).

export interface ThrottlePolicy {
  /** failures allowed per key inside the window before further attempts are refused */
  maxFailures: number;
  windowSeconds: number;
}

export const DefaultThrottlePolicy: ThrottlePolicy = { maxFailures: 5, windowSeconds: 15 * 60 };

export class Throttle {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly policy: ThrottlePolicy = DefaultThrottlePolicy) {}

  /** true when this key must be refused WITHOUT attempting verification. */
  isLimited(key: string, nowSeconds: number): boolean {
    const cutoff = nowSeconds - this.policy.windowSeconds;
    const recent = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, recent);
    return recent.length >= this.policy.maxFailures;
  }

  recordFailure(key: string, nowSeconds: number): void {
    const list = this.failures.get(key) ?? [];
    list.push(nowSeconds);
    this.failures.set(key, list);
  }

  /** Success clears the ACCOUNT key only — the Go decision: an attacker sharing your IP should not
   *  have their slate wiped because you signed in. Callers pass the account key. */
  clear(key: string): void {
    this.failures.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Trusted proxy (yourphr#529): the per-IP throttle key.

/**
 * The IP to throttle on. X-Forwarded-For is caller-controlled text UNLESS the direct peer is a
 * declared trusted proxy — in that case the rightmost XFF entry is what the proxy saw and appended,
 * so it is the only hop that cannot be forged by the original caller.
 */
export function clientIp(remoteAddr: string, xffHeader: string | undefined, trustedProxies: string[]): string {
  if (!xffHeader || !trustedProxies.includes(remoteAddr)) {
    return remoteAddr;
  }
  const hops = xffHeader.split(',').map((h) => h.trim()).filter(Boolean);
  return hops.length > 0 ? (hops[hops.length - 1] as string) : remoteAddr;
}

// ---------------------------------------------------------------------------
// The store + the flows

export interface AuthConfig {
  /** HMAC key for session tokens. Persisted by the caller; 32+ random bytes. */
  sessionKey: Buffer;
  session?: SessionPolicy;
  throttle?: ThrottlePolicy;
  /** yourphr#506 — enforced on create and change, server-side. */
  minPasswordLength?: number;
  /** direct peers whose X-Forwarded-For is believed (yourphr#529). Empty = believe nobody. */
  trustedProxies?: string[];
}

/** The one message for every sign-in failure (yourphr#104). */
export const GENERIC_SIGNIN_ERROR = 'invalid username or password';

export class AuthStore {
  private readonly session: SessionPolicy;
  private readonly throttlePolicy: ThrottlePolicy;
  private readonly minPasswordLength: number;
  private readonly trustedProxies: string[];
  readonly throttle: Throttle;

  constructor(private readonly db: InstanceType<typeof Database>, private readonly config: AuthConfig) {
    this.session = config.session ?? DefaultSessionPolicy;
    this.throttlePolicy = config.throttle ?? DefaultThrottlePolicy;
    this.minPasswordLength = config.minPasswordLength ?? 12;
    this.trustedProxies = config.trustedProxies ?? [];
    this.throttle = new Throttle(this.throttlePolicy);
    db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      token_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`);
  }

  createUser(username: string, password: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(username)) {
      throw new Error('username must be 2-63 chars: lowercase letters, digits, . _ - (leading alphanumeric)');
    }
    this.checkPolicy(password);
    this.db.prepare('INSERT INTO auth_users (username, password_hash, token_generation, created_at) VALUES (?, ?, 0, ?)')
      .run(username, hashPassword(password), new Date().toISOString());
  }

  private checkPolicy(password: string): void {
    if (password.length < this.minPasswordLength) {
      throw new Error(`password must be at least ${this.minPasswordLength} characters`);
    }
  }

  private userRow(username: string): { password_hash: string; token_generation: number } | undefined {
    return this.db.prepare('SELECT password_hash, token_generation FROM auth_users WHERE username = ?').get(username) as
      | { password_hash: string; token_generation: number }
      | undefined;
  }

  /**
   * Sign in. Throttled per account AND per IP before any verification runs; unknown users cost a
   * real hash verification and the same generic error as a wrong password.
   */
  signIn(
    username: string,
    password: string,
    request: { remoteAddr: string; xff?: string },
    nowSeconds = Math.floor(Date.now() / 1000)
  ): { ok: true; token: string } | { ok: false; error: string } {
    const ip = clientIp(request.remoteAddr, request.xff, this.trustedProxies);
    const accountKey = `acct:${username}`;
    const ipKey = `ip:${ip}`;
    if (this.throttle.isLimited(accountKey, nowSeconds) || this.throttle.isLimited(ipKey, nowSeconds)) {
      // Same generic message: "you are throttled" on a chosen username is enumeration by another door.
      return { ok: false, error: GENERIC_SIGNIN_ERROR };
    }

    const row = this.userRow(username);
    const verified = row ? verifyPassword(row.password_hash, password) : verifyPassword(dummyHash, password) && false;
    if (!row || !verified) {
      this.throttle.recordFailure(accountKey, nowSeconds);
      this.throttle.recordFailure(ipKey, nowSeconds);
      return { ok: false, error: GENERIC_SIGNIN_ERROR };
    }

    this.throttle.clear(accountKey);
    if (this.bootstrapFile && username === this.bootstrapUsername && existsSync(this.bootstrapFile)) {
      // The generated password has served its purpose; a copy inside the data dir would ride along
      // in every backup from here on (yourphr#466).
      rmSync(this.bootstrapFile, { force: true });
      this.bootstrapFile = undefined;
    }
    const claims: SessionClaims = {
      u: username,
      g: row.token_generation,
      iat: nowSeconds,
      exp: nowSeconds + this.session.slidingSeconds,
      cap: nowSeconds + this.session.absoluteSeconds,
    };
    return { ok: true, token: issueToken(this.config.sessionKey, claims) };
  }

  /**
   * Verify a session. Refuses: bad signature, past sliding expiry, past absolute cap, and a
   * token_generation behind the account's current one (yourphr#508). A valid use inside the
   * renewal half of the sliding window returns a fresh token (sliding TTL, capped — yourphr#445).
   */
  verifySession(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1000)
  ): { ok: true; username: string; renewed?: string } | { ok: false } {
    const claims = decodeToken(this.config.sessionKey, token);
    if (!claims || nowSeconds >= claims.exp || nowSeconds >= claims.cap) {
      return { ok: false };
    }
    const row = this.userRow(claims.u);
    if (!row || claims.g < row.token_generation) {
      return { ok: false };
    }

    let renewed: string | undefined;
    if (claims.exp - nowSeconds < this.session.slidingSeconds / 2) {
      const exp = Math.min(nowSeconds + this.session.slidingSeconds, claims.cap);
      renewed = issueToken(this.config.sessionKey, { ...claims, exp });
    }
    return { ok: true, username: claims.u, renewed };
  }

  /**
   * Change the password. Verifies the CURRENT password (a stolen session must not be enough to
   * change the credential that evicts it), enforces policy on the new one, and bumps
   * token_generation in the same transaction — so the change and the eviction cannot diverge
   * (yourphr#528: the counter that did not move).
   */
  changePassword(username: string, currentPassword: string, newPassword: string): { ok: boolean; error?: string } {
    const row = this.userRow(username);
    if (!row || !verifyPassword(row.password_hash, currentPassword)) {
      return { ok: false, error: GENERIC_SIGNIN_ERROR };
    }
    try {
      this.checkPolicy(newPassword);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const result = this.db
      .prepare('UPDATE auth_users SET password_hash = ?, token_generation = token_generation + 1 WHERE username = ?')
      .run(hashPassword(newPassword), username);
    if (result.changes !== 1) {
      return { ok: false, error: 'password change did not apply' };
    }
    return { ok: true };
  }

  /** Ends every session for this user, everywhere (yourphr#508's sign-out-everywhere). */
  revokeAllSessions(username: string): void {
    this.db.prepare('UPDATE auth_users SET token_generation = token_generation + 1 WHERE username = ?').run(username);
  }

  /**
   * Provision the first admin without the first-run wizard (yourphr#504). The wizard is a RACE on
   * an internet-facing host: the first account on an empty database becomes the admin, and the app
   * cannot tell the operator from a passing stranger.
   *
   * One-way and only on an EMPTY user table — never overwrites an account, never changes a
   * password. No password is supplied by the caller: one is generated and written 0600 to
   * <dataDir>/.admin_bootstrap_password; the caller logs the PATH only. The file is deleted after
   * the admin's first successful sign-in, because the data directory is exactly what a backup
   * contains (yourphr#466).
   */
  bootstrapAdmin(dataDir: string, username = 'admin'): { created: boolean; passwordFile?: string } {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n;
    if (count > 0) {
      return { created: false };
    }
    const password = randomBytes(24).toString('base64url');
    this.createUser(username, password);
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, '.admin_bootstrap_password');
    writeFileSync(file, password + '\n', { mode: 0o600 });
    this.bootstrapFile = file;
    this.bootstrapUsername = username;
    return { created: true, passwordFile: file };
  }

  private bootstrapFile?: string;
  private bootstrapUsername?: string;

  /**
   * Recovery when nobody can sign in (yourphr#510). Deliberately NOT an HTTP route: the proof of
   * being the operator is filesystem access to the data directory, the same proof that already
   * implies total control. Sets a fresh generated password, writes it 0600 to
   * <dataDir>/.recovery_password, and bumps token_generation so whoever caused the lockout is
   * signed out everywhere the moment the operator recovers.
   */
  recoverAccess(dataDir: string, username: string): { passwordFile: string } {
    const row = this.userRow(username);
    if (!row) {
      throw new Error(`no such account: ${username}`);
    }
    const password = randomBytes(24).toString('base64url');
    const result = this.db
      .prepare('UPDATE auth_users SET password_hash = ?, token_generation = token_generation + 1 WHERE username = ?')
      .run(hashPassword(password), username);
    if (result.changes !== 1) {
      throw new Error('recovery did not apply');
    }
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, '.recovery_password');
    writeFileSync(file, password + '\n', { mode: 0o600 });
    return { passwordFile: file };
  }
}
