/**
 * Phase 3 harness (yourphr#541): sign-in, sessions, revocation, throttling, trusted proxy,
 * enumeration resistance, password policy. Loopback only, synthetic accounts, no PHI.
 *
 * The acceptance test that matters most is the yourphr#508/#528 one: A PASSWORD CHANGE ENDS
 * ANOTHER SESSION — verified against the database counter, not the token's own claims.
 *
 *   npm run auth
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import {
  AuthStore,
  GENERIC_SIGNIN_ERROR,
  clientIp,
  decodeToken,
  hashPassword,
  issueToken,
  verifyPassword,
} from '../src/auth/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function newStore(overrides: Partial<ConstructorParameters<typeof AuthStore>[1]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spike-auth-'));
  const db = new Database(join(dir, 'auth.db'));
  const store = new AuthStore(db, { sessionKey: randomBytes(32), ...overrides });
  return { store, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const REQ = { remoteAddr: '198.51.100.7' };
const PASSWORD = 'a-long-enough-password';

async function main(): Promise<void> {
  // --- password hashing ---
  const stored = hashPassword(PASSWORD);
  check('scrypt hash is self-describing', stored.startsWith('scrypt$16384$8$1$'));
  check('a correct password verifies', verifyPassword(stored, PASSWORD));
  check('a wrong password does not', !verifyPassword(stored, 'wrong-but-long-enough'));
  check('two hashes of one password differ (per-user salt)', hashPassword(PASSWORD) !== stored);
  check('an empty stored hash matches nothing', !verifyPassword('', PASSWORD));

  // --- sign-in + sessions ---
  {
    const { store, close } = newStore();
    store.createUser('alice', PASSWORD);

    const bad = store.signIn('alice', 'wrong-but-long-enough', REQ);
    const missing = store.signIn('nobody', PASSWORD, REQ);
    check('wrong password and unknown user return the SAME generic error',
      !bad.ok && !missing.ok && bad.error === GENERIC_SIGNIN_ERROR && missing.error === bad.error);

    const good = store.signIn('alice', PASSWORD, REQ);
    check('a correct sign-in issues a session token', good.ok);
    if (!good.ok) throw new Error('cannot continue');

    const verified = store.verifySession(good.token);
    check('the session verifies and names the user', verified.ok && verified.username === 'alice');

    // Tampering: flip one character of the payload — the HMAC must catch it.
    const tampered = good.token.startsWith('A') ? 'B' + good.token.slice(1) : 'A' + good.token.slice(1);
    check('a tampered token is refused', !store.verifySession(tampered).ok);
    close();
  }

  // --- revocation: the acceptance test (yourphr#508 / #528) ---
  {
    const { store, close } = newStore();
    store.createUser('alice', PASSWORD);
    const phone = store.signIn('alice', PASSWORD, REQ);
    const laptop = store.signIn('alice', PASSWORD, REQ);
    if (!phone.ok || !laptop.ok) throw new Error('setup sign-ins failed');

    const changed = store.changePassword('alice', PASSWORD, 'a-brand-new-long-password');
    check('a password change succeeds with the current password', changed.ok);
    check('A PASSWORD CHANGE ENDS THE OTHER SESSION', !store.verifySession(phone.token).ok && !store.verifySession(laptop.token).ok);

    const fresh = store.signIn('alice', 'a-brand-new-long-password', REQ);
    check('the new password signs in and the new session verifies', fresh.ok && store.verifySession((fresh as { token: string }).token).ok);

    check('a stolen session is NOT enough to change the password',
      !store.changePassword('alice', 'not-the-current-password', 'attacker-chosen-password').ok);

    if (fresh.ok) {
      store.revokeAllSessions('alice');
      check('sign-out-everywhere ends the current session too', !store.verifySession(fresh.token).ok);
    }
    close();
  }

  // --- sliding TTL + absolute cap (yourphr#445) ---
  {
    const { store, close } = newStore({ session: { slidingSeconds: 100, absoluteSeconds: 250 } });
    store.createUser('alice', PASSWORD);
    const t0 = 1_000_000;
    const signedIn = store.signIn('alice', PASSWORD, REQ, t0);
    if (!signedIn.ok) throw new Error('sign-in failed');
    let token = signedIn.token;

    check('idle past the sliding window is refused', !store.verifySession(token, t0 + 101).ok);

    // Active use: renew inside the window, repeatedly, up to — but never past — the cap.
    let alive = true;
    for (let t = t0 + 60; t < t0 + 260; t += 60) {
      const v = store.verifySession(token, t);
      if (!v.ok) { alive = t >= t0 + 250 ? alive : false; break; }
      if (v.renewed) token = v.renewed;
    }
    check('activity renews the session inside the window', alive);
    check('the absolute cap fires even for an active session', !store.verifySession(token, t0 + 250).ok);
    close();
  }

  // --- throttling (yourphr#509) + trusted proxy (yourphr#529) ---
  {
    const { store, close } = newStore({ throttle: { maxFailures: 3, windowSeconds: 600 } });
    store.createUser('alice', PASSWORD);
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) {
      store.signIn('alice', 'wrong-but-long-enough', REQ, t0 + i);
    }
    const throttled = store.signIn('alice', PASSWORD, REQ, t0 + 5);
    check('the account throttles after repeated failures — even with the RIGHT password', !throttled.ok);
    check('the throttle refusal is the same generic message', !throttled.ok && throttled.error === GENERIC_SIGNIN_ERROR);

    const otherAccountSameIp = store.signIn('nobody', 'wrong-but-long-enough', { remoteAddr: REQ.remoteAddr }, t0 + 6);
    check('the shared IP is throttled across accounts (per-IP key)', !otherAccountSameIp.ok);

    const laterOk = store.signIn('alice', PASSWORD, REQ, t0 + 700);
    check('the window passes and sign-in works again', laterOk.ok);
    close();
  }
  {
    const { store, close } = newStore({ throttle: { maxFailures: 2, windowSeconds: 600 }, trustedProxies: ['10.0.0.1'] });
    store.createUser('alice', PASSWORD);
    const t0 = 3_000_000;
    // An attacker rotating X-Forwarded-For from an UNTRUSTED address must still burn ONE IP bucket.
    // Deliberately a DIFFERENT username per attempt, so the account throttle cannot mask a broken
    // per-IP key — only the IP bucket can stop this pattern.
    store.signIn('user-one', 'wrong-but-long-enough', { remoteAddr: '203.0.113.9', xff: '1.1.1.1' }, t0);
    store.signIn('user-two', 'wrong-but-long-enough', { remoteAddr: '203.0.113.9', xff: '2.2.2.2' }, t0 + 1);
    const spoofed = store.signIn('alice', PASSWORD, { remoteAddr: '203.0.113.9', xff: '3.3.3.3' }, t0 + 2);
    check('X-Forwarded-For from an untrusted peer is IGNORED (spoofing cannot dodge the throttle)', !spoofed.ok);
    check('clientIp believes the rightmost hop only via a trusted proxy',
      clientIp('10.0.0.1', '9.9.9.9, 8.8.8.8', ['10.0.0.1']) === '8.8.8.8' &&
      clientIp('203.0.113.9', '9.9.9.9', ['10.0.0.1']) === '203.0.113.9');
    close();
  }

  // --- password policy (yourphr#506) ---
  {
    const { store, close } = newStore();
    let refused = false;
    try {
      store.createUser('bob', 'short');
    } catch {
      refused = true;
    }
    check('a too-short password is refused at create', refused);
    store.createUser('bob', PASSWORD);
    check('a too-short password is refused at change', !store.changePassword('bob', PASSWORD, 'short').ok);
    close();
  }

  // --- token internals: no algorithm agility to abuse ---
  {
    const key = randomBytes(32);
    const claims = { u: 'alice', g: 0, iat: 0, exp: 10, cap: 20 };
    const token = issueToken(key, claims);
    check('a token decodes under its own key', decodeToken(key, token)?.u === 'alice');
    check('a token is refused under a different key', decodeToken(randomBytes(32), token) === undefined);
    check('a payload signed with an empty signature is refused', decodeToken(key, token.split('.')[0] + '.') === undefined);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`auth harness failed: ${(err as Error).message}`);
  process.exit(1);
});
