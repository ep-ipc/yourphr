/**
 * Passwords (yourphr#611): scrypt from node's standard library — the ngdpbase #1042 design:
 * per-user random salt, parameters carried in the stored value (`scrypt$N$r$p$salt$hash`) so cost
 * can be raised later and old hashes keep verifying, constant-time comparison. No dependency.
 *
 * Migrated accounts (yourphr#583) arrive with Go's bcrypt cost-14 hashes; they verify with bcryptjs
 * and the result asks for a REHASH to scrypt — the Users manager persists it, without a generation
 * bump, because the password did not change and sessions must survive.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { BaseAuthProvider, type AuthResult } from './BaseAuthProvider.js';
import type { UserRecord } from './BaseUsersProvider.js';

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
  const candidate = scryptSync(password, salt, expected.length, { N: Number(nStr), r: Number(rStr), p: Number(pStr) });
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Go's bcrypt hashes are $2a$/$2b$/$2y$ — anything else is this stack's own scrypt scheme. */
export function isLegacyBcrypt(stored: string): boolean {
  return /^\$2[aby]\$/.test(stored);
}

/** A real hash for the unknown-account path: an unknown user costs exactly what a wrong password costs. */
const dummyHash = hashPassword(randomBytes(16).toString('base64url'));

export class PasswordAuthProvider extends BaseAuthProvider {
  readonly name = 'password';

  hash(credential: string): string {
    return hashPassword(credential);
  }

  async authenticate(username: string, credential: string, stored: UserRecord | undefined, nowSeconds: number): Promise<AuthResult> {
    if (!stored) {
      verifyPassword(dummyHash, credential);
      return { ok: false, reason: 'no such account' };
    }
    if (isLegacyBcrypt(stored.passwordHash)) {
      if (!bcrypt.compareSync(credential, stored.passwordHash)) return { ok: false, reason: 'wrong password (legacy hash)' };
      return { ok: true, subject: username, provider: this.name, factors: ['password'], issuedAt: nowSeconds, tokenGeneration: stored.tokenGeneration, rehash: hashPassword(credential) };
    }
    if (!verifyPassword(stored.passwordHash, credential)) return { ok: false, reason: 'wrong password' };
    return { ok: true, subject: username, provider: this.name, factors: ['password'], issuedAt: nowSeconds, tokenGeneration: stored.tokenGeneration };
  }
}
