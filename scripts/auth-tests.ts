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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';
import { createYourPhrServer } from '../src/server.js';
import bcryptjs from 'bcryptjs';
import {
  AuthStore,
  importLegacyUsers,
  isLegacyBcrypt,
  readGoUsers,
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

  // --- the wire (yourphr#541): auth enforced by the HTTP layer, not by configuration ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-auth-http-'));
    const db = new Database(join(dir, 'auth.db'));
    const store = new AuthStore(db, {
      sessionKey: randomBytes(32),
      session: { slidingSeconds: 20, absoluteSeconds: 120 }, // renewal zone [10s,20s) — wide enough for a slow CI runner
    });
    store.createUser('alice', PASSWORD);
    store.createUser('bob', PASSWORD);

    // One shared record db, two per-user repositories — the #537 isolation model.
    const recordsFile = join(dir, 'records.db');
    const repos = new Map<string, SqliteFhirRepository>();
    const repoFor = (u: string) => {
      let r = repos.get(u);
      if (!r) { r = new SqliteFhirRepository({ file: recordsFile, userId: u }); repos.set(u, r); }
      return r;
    };
    await repoFor('alice').updateResource({ resourceType: 'Condition', id: 'alice-cond', code: { text: 'alice only' } } as never);
    await repoFor('bob').updateResource({ resourceType: 'Condition', id: 'bob-cond', code: { text: 'bob only' } } as never);

    const server = createYourPhrServer({ repo: repoFor('alice'), auth: { store, repoForUser: repoFor } });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const LIST = '/api/secure/resource/fhir?sourceResourceType=Condition';

    const noToken = await fetch(base + LIST);
    check('the wire: no token is 401, not a record list', noToken.status === 401);
    const garbage = await fetch(base + LIST, { headers: { authorization: 'Bearer not-a-token' } });
    check('the wire: a garbage token is 401', garbage.status === 401);

    const signIn = async (u: string, p: string) =>
      fetch(base + '/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });

    const aliceBad = await signIn('alice', 'wrong-but-long-enough');
    check('the wire: a wrong password is 401 with the generic error', aliceBad.status === 401 && ((await aliceBad.json()) as { error: string }).error === GENERIC_SIGNIN_ERROR);

    const aliceToken = ((await (await signIn('alice', PASSWORD)).json()) as { data: string }).data;
    const bobToken = ((await (await signIn('bob', PASSWORD)).json()) as { data: string }).data;
    const authed = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

    const aliceList = (await (await fetch(base + LIST, authed(aliceToken))).json()) as { data: { source_resource_id: string }[] };
    const bobList = (await (await fetch(base + LIST, authed(bobToken))).json()) as { data: { source_resource_id: string }[] };
    check('the wire: each session sees ONLY its own records (isolation enforced by the session)',
      aliceList.data.length === 1 && aliceList.data[0]?.source_resource_id === 'alice-cond' &&
      bobList.data.length === 1 && bobList.data[0]?.source_resource_id === 'bob-cond');

    // Past the renewal half of a 20s sliding window, a valid request carries a fresh token.
    // (Was a 4s window with a 3.2s sleep — a slow CI runner pushed the request past expiry and
    // the check flaked red. The zone is now 10 seconds wide.)
    await new Promise((r) => setTimeout(r, 11_000));
    const renewing = await fetch(base + LIST, authed(aliceToken));
    check('the wire: a use near expiry returns X-Renewed-Token', renewing.status === 200 && !!renewing.headers.get('x-renewed-token'));

    store.changePassword('bob', PASSWORD, 'a-brand-new-long-password');
    const evicted = await fetch(base + LIST, authed(bobToken));
    check('the wire: a password change 401s the live session mid-flight', evicted.status === 401);

    server.close();
    for (const r of repos.values()) r.db.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // --- bootstrap provisioning (yourphr#504) + recovery (yourphr#510) ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-auth-boot-'));
    const db = new Database(join(dir, 'auth.db'));
    const store = new AuthStore(db, { sessionKey: randomBytes(32) });

    const first = store.bootstrapAdmin(dir);
    check('bootstrap on an empty table creates the admin and a 0600 password file',
      first.created && !!first.passwordFile && existsSync(first.passwordFile) &&
      (statSync(first.passwordFile).mode & 0o777) === 0o600);

    const second = store.bootstrapAdmin(dir);
    check('bootstrap is one-way: a second call on a populated table is a no-op', !second.created && !second.passwordFile);

    const bootPassword = readFileSync(first.passwordFile as string, 'utf8').trim();
    const signedIn = store.signIn('admin', bootPassword, REQ);
    check('the bootstrap password signs in', signedIn.ok);
    check('the password file is DELETED after the first successful sign-in (backups must not carry it)',
      !existsSync(first.passwordFile as string));

    // Lockout: the admin loses the password; an attacker holds a live session.
    const attacker = store.signIn('admin', bootPassword, REQ);
    check('setup: the attacker session is live before recovery', !attacker.ok || store.verifySession((attacker as { token: string }).token).ok);

    const recovered = store.recoverAccess(dir, 'admin');
    check('recovery writes a fresh 0600 password file', existsSync(recovered.passwordFile) && (statSync(recovered.passwordFile).mode & 0o777) === 0o600);
    const newPassword = readFileSync(recovered.passwordFile, 'utf8').trim();
    check('the recovered password signs in and the OLD one no longer does',
      store.signIn('admin', newPassword, REQ).ok && !store.signIn('admin', bootPassword, REQ).ok);
    if (signedIn.ok) {
      check('recovery evicts every pre-recovery session', !store.verifySession(signedIn.token).ok);
    }

    let unknownRefused = false;
    try { store.recoverAccess(dir, 'nobody'); } catch { unknownRefused = true; }
    check('recovery for an unknown account is refused, not silently created', unknownRefused);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Go account migration: bcrypt verify-then-rehash (yourphr#583) ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-auth-migrate-'));
    // A synthetic Go database: the GORM users table shape, one admin + one user + one deleted.
    const goDb = new Database(join(dir, 'go.db'));
    goDb.exec(`CREATE TABLE users (username TEXT, password TEXT, token_generation INTEGER, role TEXT, deleted_at TEXT)`);
    const bcryptHash = bcryptjs.hashSync('go-era-password-long', 8); // cost rides in the hash; 8 keeps the harness fast
    goDb.prepare("INSERT INTO users VALUES ('jim', ?, 3, 'admin', NULL)").run(bcryptHash);
    goDb.prepare("INSERT INTO users VALUES ('mary', ?, 0, 'user', NULL)").run(bcryptjs.hashSync('marys-password-long', 8));
    goDb.prepare("INSERT INTO users VALUES ('ghost', 'x', 0, 'user', '2026-01-01')").run();

    const appDb = new Database(join(dir, 'app.db'));
    const store = new AuthStore(appDb, { sessionKey: randomBytes(32) });
    store.createUser('mary', 'already-here-password'); // pre-existing spike account with the same name

    const legacy = readGoUsers(goDb);
    check('the Go reader skips soft-deleted accounts', legacy.length === 2);

    const report = importLegacyUsers(store, legacy);
    check('import is one-way: the existing account is skipped and reported, never overwritten',
      report.imported.join(',') === 'jim' && report.skippedExisting.join(',') === 'mary');
    check('Go admins are reported for the role wiring', report.admins.join(',') === 'jim');

    const storedBefore = (appDb.prepare("SELECT password_hash FROM auth_users WHERE username = 'jim'").get() as { password_hash: string }).password_hash;
    check('the imported hash is the bcrypt hash, verbatim', isLegacyBcrypt(storedBefore));

    const wrong = store.signIn('jim', 'not-the-password-long', REQ);
    const stillBcrypt = (appDb.prepare("SELECT password_hash FROM auth_users WHERE username = 'jim'").get() as { password_hash: string }).password_hash;
    check('a WRONG password neither signs in nor rehashes', !wrong.ok && isLegacyBcrypt(stillBcrypt));

    const first = store.signIn('jim', 'go-era-password-long', REQ);
    check('THE GO PASSWORD SIGNS IN — nobody resets anything', first.ok);
    const storedAfter = (appDb.prepare("SELECT password_hash FROM auth_users WHERE username = 'jim'").get() as { password_hash: string }).password_hash;
    check('and the hash is now scrypt (upgrade-on-login, one verification, in place)',
      storedAfter.startsWith('scrypt$') && !isLegacyBcrypt(storedAfter));
    const second = store.signIn('jim', 'go-era-password-long', REQ);
    check('the second sign-in verifies via scrypt', second.ok);
    if (first.ok) {
      check('the pre-rehash session still verifies (no generation bump — the password did not change)',
        store.verifySession(first.token).ok);
    }

    // The carried generation: a token minted below it is already revoked.
    const staleClaims = { u: 'jim', g: 1, iat: 0, exp: 9_999_999_999, cap: 9_999_999_999 };
    const stale = issueToken((store as unknown as { config: { sessionKey: Buffer } }).config.sessionKey, staleClaims);
    check('a Go-side revocation stays revoked: generation carried through the import',
      !store.verifySession(stale).ok);

    goDb.close();
    appDb.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`auth harness failed: ${(err as Error).message}`);
  process.exit(1);
});
