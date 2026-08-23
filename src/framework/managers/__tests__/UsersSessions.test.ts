import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../Engine.js';
import { ApiContext, ApiError } from '../../ApiContext.js';
import { ConfigurationManager } from '../../ConfigurationManager.js';
import { PolicyManager } from '../PolicyManager.js';
import { FakeConfigProvider } from '../../providers/__tests__/FakeConfigProvider.js';
import { UsersManager } from '../UsersManager.js';
import { SessionsManager, GENERIC_SIGNIN_ERROR } from '../SessionsManager.js';
import { PasswordAuthProvider } from '../../providers/PasswordAuthProvider.js';
import { BaseAuthProvider, type AuthResult } from '../../providers/BaseAuthProvider.js';
import type { UserRecord } from '../../providers/BaseUsersProvider.js';
import { FakeUsersProvider } from '../../providers/__tests__/FakeUsersProvider.js';

/** A second factor for the bypass test: passes only with the one right code. */
class Totp extends BaseAuthProvider {
  readonly name = 'totp';
  hash(c: string): string { return c; }
  async authenticate(username: string, credential: string, stored: UserRecord | undefined, nowSeconds: number): Promise<AuthResult> {
    if (!stored || credential !== '123456') return { ok: false, reason: 'bad code' };
    return { ok: true, subject: username, provider: 'totp', factors: ['totp'], issuedAt: nowSeconds, tokenGeneration: stored.tokenGeneration };
  }
}

const REQ = { remoteAddr: '198.51.100.7' };
const PW = 'a-long-enough-password';
let dir: string;
let engine: Engine;
let users: UsersManager;
let sessions: SessionsManager;
let provider: FakeUsersProvider;
let sys: ApiContext;
let lines: string[];

async function boot(factors: string[] = ['password'], providers: BaseAuthProvider[] = [new PasswordAuthProvider()]): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'spike-us-'));
  engine = new Engine();
  provider = new FakeUsersProvider();
  lines = [];
  users = new UsersManager(engine, provider, new PasswordAuthProvider(), { log: (l) => lines.push(l) });
  sessions = new SessionsManager(engine, providers, { factors, session: { slidingSeconds: 100, absoluteSeconds: 250 }, throttle: { maxFailures: 2, windowSeconds: 60 } });
  engine.register('configuration', new ConfigurationManager(engine, new FakeConfigProvider())).register('policy', new PolicyManager(engine)).register('users', users).register('sessions', sessions);
  await engine.initialize();
  sys = ApiContext.system('test', 'admin', engine);
}
beforeEach(async () => { await boot(); });

describe('UsersManager — accounts, roles, policy, consent, bootstrap and recovery', () => {
  it('initialises its provider and reads the policy from configuration', async () => {
    expect(provider.initialized).toBe(true);
    await expect(users.createUser(sys, 'bob', 'short')).rejects.toMatchObject({ status: 400 });
    await expect(users.createUser(sys, 'Bad!', PW)).rejects.toMatchObject({ status: 400 });
  });

  it('an admin or a system principal creates; a member may not; duplicates are 400 "User already exists"', async () => {
    await users.createUser(sys, 'alice', PW);
    const alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
    const ops = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
    await expect(users.createUser(alice, 'x', PW)).rejects.toMatchObject({ status: 403 });
    await users.createUser(ops, 'dave', PW, 'admin');
    expect(await users.roleOf('dave')).toBe('admin');
    await expect(users.createUser(sys, 'alice', PW)).rejects.toThrow('User already exists');
    expect((await users.listUsers(ops)).map((u) => u.username).sort()).toEqual(['alice', 'dave']);
    await expect(users.listUsers(alice)).rejects.toMatchObject({ status: 403 });
  });

  it('changes a password only with the current one and the policy; the generation moves', async () => {
    await users.createUser(sys, 'alice', PW);
    const alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
    await expect(users.changePassword(alice, 'wrong-long-enough', 'another-long-password')).rejects.toMatchObject({ status: 401 });
    await expect(users.changePassword(alice, PW, 'short')).rejects.toMatchObject({ status: 400 });
    await users.changePassword(alice, PW, 'another-long-password');
    expect((await users.record('alice'))?.tokenGeneration).toBe(1);
  });

  it('admin reset hands back a generated password once and bumps the generation; unknown is 404', async () => {
    await users.createUser(sys, 'alice', PW);
    const ops = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
    const pw = await users.adminResetPassword(ops, 'alice');
    expect(pw.length).toBeGreaterThanOrEqual(12);
    expect((await users.record('alice'))?.tokenGeneration).toBe(1);
    await expect(users.adminResetPassword(ops, 'nobody')).rejects.toMatchObject({ status: 404 });
    await expect(users.adminResetPassword(ApiContext.from({ username: 'alice', role: 'user' }, engine), 'alice')).rejects.toMatchObject({ status: 403 });
    // The reset is recorded by WHO did it (yourphr#619) — the route used to log a nameless "admin".
    expect(lines).toEqual(['ops reset the password for alice; every session of that account ended']);
  });

  it('consent folds into Users and goes with the account', async () => {
    await users.createUser(sys, 'alice', PW);
    const alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
    expect(await users.consentAcceptedAt(alice)).toBe('');
    await users.setConsent(alice, '2026-03-01T10:00:00Z');
    expect(await users.consentAcceptedAt(alice)).toBe('2026-03-01T10:00:00Z');
    expect(await users.deleteSelf(alice)).toBe(true);
    expect(await users.record('alice')).toBeUndefined();
  });

  it('bootstrap creates the first admin once with a 0600 file, the file goes at first sign-in; recovery ends sessions', async () => {
    const first = await users.bootstrapAdmin(dir);
    expect(first.created).toBe(true);
    expect((await users.bootstrapAdmin(dir)).created).toBe(false);
    expect(await users.isAdmin('admin')).toBe(true);
    const rec = await users.recoverAccess(dir, 'admin');
    expect(rec.passwordFile.endsWith('.recovery_password')).toBe(true);
    expect((await users.record('admin'))?.tokenGeneration).toBe(1);
    await expect(users.recoverAccess(dir, 'nobody')).rejects.toThrow('no such account');
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports legacy accounts one-way as a system principal, refusing non-bcrypt hashes and people', async () => {
    await users.createUser(sys, 'mary', PW);
    const tool = ApiContext.system('migration', '', engine);
    const report = await users.importLegacy(tool, [
      { username: 'jim', passwordHash: '$2a$04$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345', tokenGeneration: 3, role: 'admin' },
      { username: 'mary', passwordHash: '$2a$04$x', tokenGeneration: 0, role: 'user' },
    ]);
    expect(report).toEqual({ imported: ['jim'], skippedExisting: ['mary'], admins: ['jim'] });
    expect(await users.roleOf('jim')).toBe('admin');
    await expect(users.importLegacy(tool, [{ username: 'z', passwordHash: 'scrypt$x', tokenGeneration: 0, role: 'user' }])).rejects.toThrow('not a Go bcrypt hash');
    await expect(users.importLegacy(ApiContext.from({ username: 'mary', role: 'user' }, engine), [])).rejects.toMatchObject({ status: 403 });
  });
});

describe('SessionsManager — sign-in, tokens, revocation, throttling, cardinality', () => {
  it('signs in with a token carrying the generation; wrong password and unknown account get the one generic error', async () => {
    await users.createUser(sys, 'alice', PW);
    const ok = await sessions.signIn('alice', { password: PW }, REQ, 1000);
    expect(ok.ok).toBe(true);
    const v = await sessions.verify((ok as { token: string }).token, 1010);
    expect(v).toMatchObject({ ok: true, principal: { username: 'alice', role: 'user', tokenGeneration: 0 } });
    expect(await sessions.signIn('alice', { password: 'wrong-but-long-enough' }, REQ, 1000)).toEqual({ ok: false, error: GENERIC_SIGNIN_ERROR });
    expect(await sessions.signIn('ghost', { password: PW }, REQ, 1000)).toEqual({ ok: false, error: GENERIC_SIGNIN_ERROR });
  });

  it('revocation: a password change, a sign-out-everywhere, and a generation bump all end the session', async () => {
    await users.createUser(sys, 'alice', PW);
    const alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
    const t1 = (await sessions.signIn('alice', { password: PW }, REQ, 1)) as { token: string };
    await users.changePassword(alice, PW, 'another-long-password');
    expect((await sessions.verify(t1.token, 2)).ok).toBe(false);
    const t2 = (await sessions.signIn('alice', { password: 'another-long-password' }, REQ, 3)) as { token: string };
    await sessions.revokeAll(alice);
    expect((await sessions.verify(t2.token, 4)).ok).toBe(false);
    expect(await sessions.issueFor('nobody')).toBeUndefined();
    expect((await sessions.verify((await sessions.issueFor('alice'))!, 5)).ok).toBe(true);
    await expect(sessions.revokeAll(ApiContext.anonymous(engine))).rejects.toBeInstanceOf(ApiError);
  });

  it('sliding TTL renews inside the half-window and never past the absolute cap', async () => {
    await users.createUser(sys, 'alice', PW);
    const t = ((await sessions.signIn('alice', { password: PW }, REQ, 1000)) as { token: string }).token;
    expect((await sessions.verify(t, 1040)) as object).not.toHaveProperty('renewed');
    const late = await sessions.verify(t, 1060);
    expect(late.ok && !!late.renewed).toBe(true);
    expect((await sessions.verify(t, 1100)).ok).toBe(false);
    const renewed = (late as { renewed: string }).renewed;
    expect((await sessions.verify(renewed, 1120)).ok).toBe(true);
    expect((await sessions.verify(renewed, 1250)).ok).toBe(false);
  });

  it('throttles per account AND per IP, and the window slides', async () => {
    await users.createUser(sys, 'alice', PW);
    await users.createUser(sys, 'bob', PW);
    for (let i = 0; i < 2; i++) await sessions.signIn('alice', { password: 'wrong-but-long-enough' }, { remoteAddr: '203.0.113.5' }, 100 + i);
    expect((await sessions.signIn('alice', { password: PW }, { remoteAddr: '203.0.113.9' }, 110)).ok).toBe(false);
    expect((await sessions.signIn('bob', { password: PW }, { remoteAddr: '203.0.113.5' }, 111)).ok).toBe(false);
    expect((await sessions.signIn('bob', { password: PW }, { remoteAddr: '203.0.113.77' }, 112)).ok).toBe(true);
    expect((await sessions.signIn('alice', { password: PW }, { remoteAddr: '203.0.113.9' }, 200)).ok).toBe(true);
  });

  it('persists an upgraded hash after a legacy sign-in without bumping the generation', async () => {
    const { default: bcryptjs } = await import('bcryptjs');
    await users.importLegacy(ApiContext.system('migration', '', engine), [{ username: 'jim', passwordHash: bcryptjs.hashSync('go-era-password-long', 4), tokenGeneration: 3, role: 'user' }]);
    const r = await sessions.signIn('jim', { password: 'go-era-password-long' }, REQ, 1);
    expect(r.ok).toBe(true);
    const rec = await users.record('jim');
    expect(rec?.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(rec?.tokenGeneration).toBe(3);
  });

  it('ALL-OF factors: password alone does not sign in when totp is also required; a missing factor provider refuses to boot', async () => {
    await boot(['password', 'totp'], [new PasswordAuthProvider(), new Totp()]);
    await users.createUser(sys, 'alice', PW);
    // Each refusal counts against the throttle (2 per window here), so the attempts sit in separate windows.
    expect((await sessions.signIn('alice', { password: PW }, REQ, 1)).ok).toBe(false);
    expect((await sessions.signIn('alice', { password: PW, totp: '000000' }, REQ, 100)).ok).toBe(false);
    expect((await sessions.signIn('alice', { totp: '123456' }, REQ, 200)).ok).toBe(false);
    expect((await sessions.signIn('alice', { password: PW, totp: '123456' }, REQ, 300)).ok).toBe(true);
    await expect(boot(['password', 'totp'], [new PasswordAuthProvider()])).rejects.toThrow('no such auth provider');
  });
});
