/**
 * Agent tokens (yourphr#695) — the credential a patient hands an agent to read their records.
 *
 * The teeth here are the three properties that make delegation safe, and each one fails SILENTLY
 * if it regresses: the token reads only what it was given, it cannot extend or manage itself, and
 * a broken expiry date stops it rather than freeing it. All three were defects found in the
 * ngdpbase manager this is adopted from (its #1108), which is why they are asserted rather than
 * assumed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { Engine } from '../../Engine.js';
import { ApiContext } from '../../ApiContext.js';
import { AgentTokensManager, TOKEN_PREFIX } from '../AgentTokensManager.js';
import { SqliteAgentTokensProvider } from '../../providers/SqliteAgentTokensProvider.js';

/** Only what the manager reads, so a policy change in a test is one line. */
class FakeConfig {
  readonly name = 'configuration' as const;
  readonly dependsOn = [] as const;
  values: Record<string, unknown> = {};
  getBool(key: string): boolean { return this.values[key] === true; }
  getInt(key: string): number { return Number(this.values[key]); }
  async initialize(): Promise<void> { /* nothing to do */ }
  async shutdown(): Promise<void> { /* nothing to do */ }
  isInitialized(): boolean { return true; }
  async backup(): Promise<never> { throw new Error('not used'); }
  async restore(): Promise<never> { throw new Error('not used'); }
}

const BASE_POLICY = {
  'yourphr.auth.agent-token.enabled': true,
  'yourphr.auth.agent-token.read-only': true,
  'yourphr.auth.agent-token.default-ttl-hours': 24,
  'yourphr.auth.agent-token.max-ttl-hours': 24,
  'yourphr.auth.agent-token.max-per-user': 10,
  'yourphr.auth.agent-token.retention-days': 30,
  'yourphr.auth.agent-token.renewable': true,
  'yourphr.auth.agent-token.max-renewals': 0,
  'yourphr.auth.agent-token.renew-window-hours': 6,
};

/**
 * The audit door, recording only what the assertions read. Registered because the manager now
 * DEPENDS on it (yourphr#698 item 4): a credential whose life nothing records is one the store
 * alone remembers, and retention deletes that.
 */
class FakeAudit {
  readonly name = 'audit' as const;
  readonly dependsOn = [] as const;
  events: { owner: string; category: string; at: Date }[] = [];
  failNext = false;
  async record(ctx: { username: string }, category: string, at = new Date()): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('audit sink refused the write'); }
    this.events.push({ owner: ctx.username, category, at });
  }
  async initialize(): Promise<void> { /* nothing to do */ }
  async shutdown(): Promise<void> { /* nothing to do */ }
  isInitialized(): boolean { return true; }
  async backup(): Promise<never> { throw new Error('not used'); }
  async restore(): Promise<never> { throw new Error('not used'); }
}

let db: InstanceType<typeof Database>;
let engine: Engine;
let tokens: AgentTokensManager;
let config: FakeConfig;
let audit: FakeAudit;
let jim: ApiContext;
let pat: ApiContext;

async function boot(overrides: Record<string, unknown> = {}): Promise<void> {
  db = new Database(':memory:');
  engine = new Engine();
  config = new FakeConfig();
  config.values = { ...BASE_POLICY, ...overrides };
  engine.register('configuration', config as never);
  audit = new FakeAudit();
  engine.register('audit', audit as never);
  tokens = new AgentTokensManager(engine, new SqliteAgentTokensProvider(db));
  engine.register('agentTokens', tokens);
  await engine.initialize();
  jim = ApiContext.from({ username: 'jim', role: 'user' }, engine);
  pat = ApiContext.from({ username: 'pat', role: 'user' }, engine);
}

beforeEach(async () => { await boot(); });

describe('minting', () => {
  it('returns the cleartext once and never stores it', async () => {
    const { token, record } = await tokens.mint(jim, 'Claude Desktop', ['Medications']);
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect((record as Record<string, unknown>).hash).toBeUndefined();

    const stored = db.prepare('SELECT hash, prefix FROM agent_tokens').get() as { hash: string; prefix: string };
    expect(stored.hash.startsWith('sha256:')).toBe(true);
    expect(stored.hash).not.toContain(token);
    expect(token.startsWith(stored.prefix)).toBe(true);
  });

  it('REFUSES an unscoped token rather than reading it as unrestricted', async () => {
    // The Go token this replaces scoped to the whole account. Empty must never mean everything.
    await expect(tokens.mint(jim, 'x', [])).rejects.toThrow(/at least one/i);
  });

  it('refuses a scope this instance cannot share, naming it', async () => {
    // Named rather than dropped: silently ignoring one mints a token that reads less than the
    // patient was told, which they meet later as a broken agent.
    await expect(tokens.mint(jim, 'x', ['Medications', 'Bank details'])).rejects.toThrow(/Bank details/);
  });

  it('refuses a TTL over the ceiling, and has no "never expires"', async () => {
    await expect(tokens.mint(jim, 'x', ['Summary'], 48)).rejects.toThrow(/at most 24 hours/);
    await expect(tokens.mint(jim, 'x', ['Summary'], 0)).rejects.toThrow(/positive/);
  });

  it('enforces the per-user cap, and a revoke frees a slot', async () => {
    await boot({ 'yourphr.auth.agent-token.max-per-user': 2 });
    const first = await tokens.mint(jim, 'a', ['Summary']);
    await tokens.mint(jim, 'b', ['Summary']);
    await expect(tokens.mint(jim, 'c', ['Summary'])).rejects.toThrow(/revoke one first/);
    // Another account is unaffected.
    await expect(tokens.mint(pat, 'a', ['Summary'])).resolves.toBeTruthy();
    await tokens.revoke(jim, first.record.id);
    await expect(tokens.mint(jim, 'c', ['Summary'])).resolves.toBeTruthy();
  });

  it('is off unless an operator turns it on', async () => {
    await boot({ 'yourphr.auth.agent-token.enabled': false });
    await expect(tokens.mint(jim, 'x', ['Summary'])).rejects.toThrow(/not enabled/);
  });

  it('a typo in max-ttl-hours falls back rather than removing the ceiling', async () => {
    // Number('24h') is NaN and `ttl > NaN` is false — the config hole found in ngdpbase#1108.
    await boot({ 'yourphr.auth.agent-token.max-ttl-hours': '24h' });
    await expect(tokens.mint(jim, 'x', ['Summary'], 24 * 365)).rejects.toThrow(/at most 24 hours/);
  });
});

describe('verifying', () => {
  it('accepts a live token and answers the owner and scopes', async () => {
    const { token } = await tokens.mint(jim, 'Claude', ['Medications', 'Conditions']);
    const verified = await tokens.verify(token);
    expect(verified?.owner).toBe('jim');
    expect(verified?.scopes).toEqual(['Medications', 'Conditions']);
  });

  it('refuses an unknown value, a prefix-less one, an expired one and a revoked one', async () => {
    const { token, record } = await tokens.mint(jim, 'x', ['Summary'], 1);
    expect(await tokens.verify(`${TOKEN_PREFIX}made-up`)).toBeUndefined();
    expect(await tokens.verify(token.slice(TOKEN_PREFIX.length))).toBeUndefined();
    expect(await tokens.verify(token, Date.now() + 2 * 3_600_000)).toBeUndefined();
    await tokens.revoke(jim, record.id);
    expect(await tokens.verify(token)).toBeUndefined();
  });

  it('TOOTH: an unreadable expiry stops the token AND keeps it visible', async () => {
    // ngdpbase#1108's worst defect: NaN <= now and NaN > now are BOTH false, so a broken date read
    // as valid on the verify path and as not-live on the listing path — a token that authenticated
    // forever and appeared in no list, not even an admin's.
    const { token, record } = await tokens.mint(jim, 'x', ['Summary']);
    db.prepare('UPDATE agent_tokens SET expires_at = ? WHERE id = ?').run('soon', record.id);

    expect(await tokens.verify(token)).toBeUndefined();
    const listed = (await tokens.listForOwner(jim)).find((t) => t.id === record.id);
    expect(listed).toBeDefined();          // still visible, so it can be revoked
    expect(listed?.live).toBe(false);
    expect(listed?.expiresInSeconds).toBe(0);
  });

  it('TOOTH: a corrupt scope list reads NOTHING rather than everything', async () => {
    const { token, record } = await tokens.mint(jim, 'x', ['Summary']);
    db.prepare('UPDATE agent_tokens SET scopes = ? WHERE id = ?').run('{not json', record.id);
    expect(await tokens.verify(token)).toBeUndefined();
  });

  it('stamps last use, so the account page can show it', async () => {
    const { token, record } = await tokens.mint(jim, 'x', ['Summary']);
    expect((await tokens.listForOwner(jim))[0]?.lastUsedAt).toBe('');
    await tokens.verify(token);
    expect((await tokens.listForOwner(jim)).find((t) => t.id === record.id)?.lastUsedAt).not.toBe('');
  });

  it('answers nothing at all while the feature is off', async () => {
    const { token } = await tokens.mint(jim, 'x', ['Summary']);
    await boot({ 'yourphr.auth.agent-token.enabled': false });
    expect(await tokens.verify(token)).toBeUndefined();
  });
});

describe('an agent cannot manage tokens — including its own', () => {
  const asAgent = (scopes: string[] = ['Summary']): ApiContext =>
    ApiContext.agent('jim', { id: 'tok_x', name: 'Claude', scopes }, engine);

  it('TOOTH: refuses mint, renew and revoke from an agent context', async () => {
    // The rule that keeps the 24-hour cap real: a credential that can extend its own life is not
    // delegated any more. ngdpbase shipped NO renew rather than one a token could reach.
    const { record } = await tokens.mint(jim, 'x', ['Summary']);
    const agent = asAgent();
    await expect(tokens.mint(agent, 'y', ['Summary'])).rejects.toThrow(/cannot manage agent tokens/);
    await expect(tokens.renew(agent, record.id)).rejects.toThrow(/cannot manage agent tokens/);
    await expect(tokens.revoke(agent, record.id)).rejects.toThrow(/cannot manage agent tokens/);
    await expect(tokens.listForOwner(agent)).rejects.toThrow(/cannot manage agent tokens/);
  });

  it('the access log names the AGENT, not the patient', async () => {
    // yourphr#657 assumed this already worked. "Claude Desktop read your medications", not "you did".
    expect(asAgent().actor).toBe('Claude');
    expect(jim.actor).toBe('jim');
  });

  it('reads only the categories its token names', async () => {
    const agent = asAgent(['Medications']);
    expect(agent.canRead('Medications')).toBe(true);
    expect(agent.canRead('Full export')).toBe(false);
    // A person is not scope-limited; categories are not a permission gate for people.
    expect(jim.canRead('Full export')).toBe(true);
  });

  it('TOOTH: widening the scopes of a context cannot widen the token', async () => {
    const scopes = ['Medications'];
    const agent = ApiContext.agent('jim', { id: 'tok_x', name: 'Claude', scopes }, engine);
    scopes.push('Full export');                       // the caller's array moves on...
    expect(agent.canRead('Full export')).toBe(false); // ...the context does not
    expect(() => (agent.viaToken!.scopes as string[]).push('Full export')).toThrow();
  });

  it('never carries an admin power, whoever owns it', async () => {
    const owner = ApiContext.agent('admin', { id: 'tok_x', name: 'Claude', scopes: ['Summary'] }, engine);
    expect(owner.can('admin-read')).toBe(false);
    expect(owner.role).toBe('user');
  });
});

describe('renewal', () => {
  /** Mint, then stand near the expiry so the renewal window is open. */
  async function mintNearExpiry(name = 'Claude', scopes = ['Medications']) {
    const minted = await tokens.mint(jim, name, scopes);
    return { minted, nearExpiry: Date.parse(minted.record.expiresAt) - 60_000 };
  }

  it('issues a NEW secret and retires the old record rather than moving a date', async () => {
    const { minted, nearExpiry } = await mintNearExpiry();
    const renewed = await tokens.renew(jim, minted.record.id, nearExpiry);

    expect(renewed.token).not.toBe(minted.token);
    // The old secret dies at its original expiry however many times the owner renews.
    expect(await tokens.verify(minted.token, nearExpiry)).toBeUndefined();
    expect(await tokens.verify(renewed.token, nearExpiry)).toBeTruthy();

    // Name and scopes carry, so the agent's identity in the access log stays continuous.
    expect(renewed.record.name).toBe(minted.record.name);
    expect(renewed.record.scopes).toEqual(minted.record.scopes);
    expect(renewed.record.renewals).toBe(1);
    expect(renewed.record.renewedFrom).toBe(minted.record.id);
    // The rotation stays visible until retention drops it.
    expect((await tokens.listForOwner(jim, nearExpiry)).find((t) => t.id === minted.record.id)?.revokedAt).not.toBe('');
  });

  it('only within the window — not on day one', async () => {
    const { minted } = await mintNearExpiry();
    await expect(tokens.renew(jim, minted.record.id)).rejects.toThrow(/within 6 hours/);
  });

  it('refuses another account\'s token the same way it refuses one that does not exist', async () => {
    // A distinguishable answer would let one account probe for another's token ids.
    const { minted, nearExpiry } = await mintNearExpiry();
    await expect(tokens.renew(pat, minted.record.id, nearExpiry)).rejects.toThrow(/no such token/);
    await expect(tokens.renew(pat, 'tok_nope', nearExpiry)).rejects.toThrow(/no such token/);
  });

  it('refuses an expired or revoked token — renewal is not resurrection', async () => {
    const { minted } = await mintNearExpiry();
    const afterExpiry = Date.parse(minted.record.expiresAt) + 1000;
    await expect(tokens.renew(jim, minted.record.id, afterExpiry)).rejects.toThrow(/expired/);

    const second = await mintNearExpiry();
    await tokens.revoke(jim, second.minted.record.id);
    await expect(tokens.renew(jim, second.minted.record.id, second.nearExpiry)).rejects.toThrow(/revoked/);
  });

  it('honours max-renewals when the operator sets one', async () => {
    await boot({ 'yourphr.auth.agent-token.max-renewals': 1 });
    const { minted, nearExpiry } = await mintNearExpiry();
    const once = await tokens.renew(jim, minted.record.id, nearExpiry);
    const nextWindow = Date.parse(once.record.expiresAt) - 60_000;
    await expect(tokens.renew(jim, once.record.id, nextWindow)).rejects.toThrow(/renewed 1 times/);
  });

  it('can be turned off entirely', async () => {
    await boot({ 'yourphr.auth.agent-token.renewable': false });
    const { minted, nearExpiry } = await mintNearExpiry();
    await expect(tokens.renew(jim, minted.record.id, nearExpiry)).rejects.toThrow(/cannot be renewed/);
  });
});

describe('listing, revocation and retention', () => {
  it('TOOTH: one account never sees or revokes another\'s tokens', async () => {
    const mine = await tokens.mint(jim, 'mine', ['Summary']);
    await tokens.mint(pat, 'theirs', ['Summary']);
    expect((await tokens.listForOwner(jim)).map((t) => t.name)).toEqual(['mine']);
    await expect(tokens.revoke(pat, mine.record.id)).rejects.toThrow(/no such token/);
  });

  it('shows time remaining, which is what the account page needs instead of a notification', async () => {
    const { record } = await tokens.mint(jim, 'x', ['Summary'], 24);
    const listed = (await tokens.listForOwner(jim))[0];
    expect(listed?.live).toBe(true);
    expect(listed?.expiresInSeconds).toBeGreaterThan(23 * 3600);
    expect(listed?.expiresInSeconds).toBeLessThanOrEqual(24 * 3600);
    expect(listed?.id).toBe(record.id);
  });

  it('revoking twice is a no-op, not an error', async () => {
    const { record } = await tokens.mint(jim, 'x', ['Summary']);
    expect(await tokens.revoke(jim, record.id)).toBe(true);
    expect(await tokens.revoke(jim, record.id)).toBe(false);
  });

  it('purges dead records past retention and keeps live ones', async () => {
    await tokens.mint(jim, 'live', ['Summary']);
    await tokens.mint(jim, 'short', ['Summary'], 1);
    expect(await tokens.purgeExpired()).toBe(0);           // nothing dead long enough yet
    expect(await tokens.purgeExpired(Date.now() + 40 * 86_400_000)).toBe(2);
  });

  it('an account\'s tokens go when the account does', async () => {
    await tokens.mint(jim, 'x', ['Summary']);
    await tokens.mint(pat, 'y', ['Summary']);
    await tokens.removeForUser(jim);
    expect(await tokens.listForOwner(jim)).toHaveLength(0);
    expect(await tokens.listForOwner(pat)).toHaveLength(1);
  });
});

/**
 * The four constraints yourphr#698 carried over from the ngdpbase review (its #1110). Two were
 * already held by this design and are asserted so they stay held; two were not, and are the
 * behaviour below.
 */
describe('yourphr#698: what a credential store owes', () => {
  it('1. a backup of the token store carries no credential material — not even a listing', async () => {
    // Restoring a credential store UN-REVOKES, so there is deliberately nothing here to restore
    // from: the rows ride the app database's own encrypted backup or they do not exist.
    await tokens.mint(jim, 'x', ['Summary']);
    const taken = await tokens.backup();
    expect(JSON.stringify(taken)).not.toContain('sha256:');
    expect((taken as unknown as Record<string, unknown>)['payload']).toBeUndefined();
  });

  it('2. retention-days 0 is an instruction, not a typo — a dead record goes at once', async () => {
    await boot({ 'yourphr.auth.agent-token.retention-days': 0 });
    const { record } = await tokens.mint(jim, 'x', ['Summary']);
    await tokens.mint(jim, 'keep', ['Summary']);
    await tokens.revoke(jim, record.id);
    expect(await tokens.purgeExpired()).toBe(1);
    // The live one is untouched: "dropped as soon as it is dead" is not "dropped".
    expect((await tokens.listForOwner(jim)).map((t) => t.name)).toEqual(['keep']);
  });

  it('2. max-per-user 0 means no token may be minted, rather than silently meaning 10', async () => {
    await boot({ 'yourphr.auth.agent-token.max-per-user': 0 });
    await expect(tokens.mint(jim, 'x', ['Summary'])).rejects.toThrow(/revoke one first|already have 0/);
  });

  it('2. a value that is not a number still falls back — a typo must not remove a limit', async () => {
    await boot({ 'yourphr.auth.agent-token.retention-days': 'thirty' });
    await tokens.mint(jim, 'x', ['Summary']);
    // 30 days, the shipped default: nothing dead yet, so nothing goes.
    expect(await tokens.purgeExpired()).toBe(0);
  });

  it('3. scopes are normalised at the MINT and stored normalised', async () => {
    // ngdpbase validated a trimmed scope and stored the untrimmed one, so the credential minted
    // and then matched nothing. Authorisation is exact membership; normalise once, at the door.
    const { record } = await tokens.mint(jim, 'x', ['  Medications  ', 'Medications']);
    expect(record.scopes).toEqual(['Medications']);
    const stored = db.prepare('SELECT scopes FROM agent_tokens').get() as { scopes: string };
    expect(JSON.parse(stored.scopes)).toEqual(['Medications']);
  });

  it('4. mint, renewal and revocation reach the access log, which outlives the row', async () => {
    const { record } = await tokens.mint(jim, 'Claude', ['Summary'], 24);
    const renewed = await tokens.renew(jim, record.id, Date.now() + 23 * 3_600_000);
    await tokens.revoke(jim, renewed.record.id);
    expect(audit.events.map((e) => e.category)).toEqual([
      'Agent token minted', 'Agent token renewed', 'Agent token revoked',
    ]);
    expect(audit.events.every((e) => e.owner === 'jim')).toBe(true);

    // The point of writing them there: retention takes the rows, and the answer survives.
    expect(await tokens.purgeExpired(Date.now() + 40 * 86_400_000)).toBeGreaterThan(0);
    expect(await tokens.listForOwner(jim)).toHaveLength(0);
    expect(audit.events).toHaveLength(3);
  });

  it('4. a mint the log could not record FAILS, rather than handing back an unlogged credential', async () => {
    audit.failNext = true;
    await expect(tokens.mint(jim, 'x', ['Summary'])).rejects.toThrow(/audit sink/);
  });

  it('4. a revoke stands even if the log write fails — the token is dead either way', async () => {
    const { record } = await tokens.mint(jim, 'x', ['Summary']);
    audit.failNext = true;
    await expect(tokens.revoke(jim, record.id)).rejects.toThrow(/audit sink/);
    expect((await tokens.listForOwner(jim))[0]?.live).toBe(false);
  });

  it('a lifecycle category can never be granted as a scope', async () => {
    // The scope vocabulary is the ACCESS categories; management is not a read surface.
    await expect(tokens.mint(jim, 'x', ['Agent token minted'])).rejects.toThrow(/not something this instance can share/);
  });
});
