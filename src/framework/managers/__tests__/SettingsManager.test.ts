import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../../Engine.js';
import { ApiContext, ApiError } from '../../ApiContext.js';
import { ConfigurationManager } from '../../ConfigurationManager.js';
import { SettingsManager, coerceToShippedType } from '../SettingsManager.js';
import { FakeConfigProvider } from '../../providers/__tests__/FakeConfigProvider.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function boot(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spike-settings-')); dirs.push(dir);
  const engine = new Engine();
  const log: string[] = [];
  engine.register('configuration', new ConfigurationManager(engine, new FakeConfigProvider(), { env: env }));
  const settings = new SettingsManager(engine, { log: (line) => log.push(line), dataDir: dir });
  engine.register('settings', settings);
  await engine.initialize();
  const admin = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
  const member = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  const nobody = ApiContext.anonymous(engine);
  return { engine, settings, log, admin, member, nobody, dir };
}

describe('SettingsManager — what the instance says about itself, with the caller passed in', () => {
  it('boots after configuration and publishes only the public keys to an anonymous caller', async () => {
    const { engine, settings, nobody } = await boot();
    expect(engine.registered).toEqual(['configuration', 'settings']);
    const pub = settings.publicInstance(nobody);
    expect(Object.keys(pub).sort()).toEqual(['operator.contact_url', 'operator.name', 'password.min_length']);
    expect(pub).not.toHaveProperty('operator.contact_email');
  });

  it('the signed-in view adds the operator contact; anonymous is refused', async () => {
    const { settings, member, nobody, admin } = await boot();
    settings.setInstanceSettings(admin, { name: 'Ops', contact_email: 'ops@example.org', contact_url: 'https://example.org/help' });
    const mine = settings.instanceForUser(member);
    expect(mine['operator.contact_email']).toBe('ops@example.org');
    expect(mine['demo.admin.session']).toBe(false);
    expect(() => settings.instanceForUser(nobody)).toThrow(ApiError);
  });

  it('the admin card is the admin\'s alone — a member gets 403 from the manager, not only the route', async () => {
    const { settings, member } = await boot();
    for (const call of [
      () => settings.configSnapshot(member),
      () => settings.configReveal(member, 'operator.name'),
      () => settings.configSet(member, 'operator.name', 'x'),
      () => settings.configReset(member, 'operator.name'),
      () => settings.instanceSettings(member),
      () => settings.setInstanceSettings(member, { name: '', contact_email: '', contact_url: '' }),
    ]) {
      let status = 0;
      try { call(); } catch (err) { status = (err as ApiError).status; }
      expect(status).toBe(403);
    }
  });

  it('snapshot: Go\'s row shape — secrets masked, env-pinned marked, public keys named', async () => {
    const { settings, admin } = await boot({ SPIKE_BACKUP_ENCRYPTION_KEY: 'from-env' });
    const snap = settings.configSnapshot(admin);
    const byKey = Object.fromEntries(snap.entries.map((e) => [e.key, e]));
    expect(byKey['backup.encryption.key']).toMatchObject({ masked: true, value: '••••', from_env: true, env_var: 'SPIKE_BACKUP_ENCRYPTION_KEY', bootstrap: true });
    expect(byKey['operator.name']).toMatchObject({ public: true, source: 'default', from_env: false });
    expect(byKey['operator.contact_email']?.public).toBe(false);
    // Where the overrides live comes from the PROVIDER, not from the manager guessing a filename
    // (yourphr#621) — with the in-memory provider there is no file, and the screen says so.
    expect(snap.custom_config_path).toBe('<in-memory>');
  });

  it('reveal is logged by the actor, never a bare "admin"', async () => {
    const { settings, admin, log } = await boot({ SPIKE_BACKUP_ENCRYPTION_KEY: 'from-env' });
    expect(settings.configReveal(admin, 'backup.encryption.key')).toEqual({ key: 'backup.encryption.key', value: 'from-env', default: '' });
    expect(settings.configReveal(admin, 'nope.key')).toBeUndefined();
    expect(log).toEqual(['ops revealed configuration value for backup.encryption.key']);
  });

  it('set: unknown key 400, env-pinned 409, wrong shape 400, otherwise coerced to the shipped type and logged', async () => {
    const { settings, admin, engine, log } = await boot({ SPIKE_SYNC_MAX_PAGES: '9' });
    const status = (fn: () => void): number => { try { fn(); return 200; } catch (err) { return (err as ApiError).status; } };
    expect(status(() => settings.configSet(admin, 'nope.key', 1))).toBe(400);
    expect(status(() => settings.configSet(admin, 'sync.max-pages', 5))).toBe(409);
    expect(status(() => settings.configSet(admin, 'backup.max-backups', 'many'))).toBe(400);
    expect(status(() => settings.configSet(admin, 'backup.encryption.key', 'x'))).toBe(400); // bootstrap: env only
    settings.configSet(admin, 'backup.max-backups', '3');
    expect(engine.managers.configuration.getInt('backup.max-backups')).toBe(3);
    settings.configSet(admin, 'backup.schedule.enabled', 'true');
    expect(engine.managers.configuration.getBool('backup.schedule.enabled')).toBe(true);
    expect(log).toEqual(['ops set configuration backup.max-backups', 'ops set configuration backup.schedule.enabled']);
  });

  it('reset: clears an override (true), says when there was none (false), refuses an unknown key', async () => {
    const { settings, admin, engine } = await boot();
    settings.configSet(admin, 'backup.max-backups', 3);
    expect(settings.configReset(admin, 'backup.max-backups')).toBe(true);
    expect(engine.managers.configuration.getInt('backup.max-backups')).toBe(7);
    expect(settings.configReset(admin, 'backup.max-backups')).toBe(false);
    expect(() => settings.configReset(admin, 'nope.key')).toThrow(ApiError);
  });

  it('instance settings: trimmed and stored; a malformed address or URL is refused before anything is written', async () => {
    const { settings, admin } = await boot();
    expect(() => settings.setInstanceSettings(admin, { name: 'Ops', contact_email: 'not-an-email', contact_url: '' })).toThrow('contact_email is not an email address');
    expect(() => settings.setInstanceSettings(admin, { name: 'Ops', contact_email: '', contact_url: 'ftp://x' })).toThrow('contact_url must start with http:// or https://');
    expect(settings.instanceSettings(admin)).toEqual({ name: '', contact_email: '', contact_url: '' });
    const saved = settings.setInstanceSettings(admin, { name: ' Ops Team ', contact_email: 'ops@example.org', contact_url: 'https://example.org/help' });
    expect(saved.name).toBe('Ops Team');
    expect(settings.instanceSettings(admin)).toEqual(saved);
  });

  it('the legal text is public, shipped unless the operator overrides it, and an unusable override is an error rather than a silent fallback (yourphr#619)', async () => {
    const { settings, nobody, dir } = await boot();
    const shipped = settings.legalDocument(nobody, 'privacy');
    expect(shipped).toMatchObject({ kind: 'privacy', source: 'shipped' });
    expect(shipped?.html).toContain('<');
    expect(settings.legalDocument(nobody, 'PRIVACY')).toMatchObject({ kind: 'privacy' }); // Go accepts either case
    expect(settings.legalDocument(nobody, 'nonsense')).toBeUndefined();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'terms-of-service.md'), '# Our terms\n');
    const overridden = settings.legalDocument(nobody, 'terms');
    expect(overridden).toMatchObject({ kind: 'terms', source: 'operator' });
    expect(overridden?.markdown).toBe('# Our terms\n');
    writeFileSync(join(dir, 'config', 'terms-of-service.md'), '   \n');
    expect(() => settings.legalDocument(nobody, 'terms')).toThrow(/empty/);
  });

  it('backup() carries nothing of its own — the configuration manager\'s overlay is what travels', async () => {
    const { settings } = await boot();
    const data = await settings.backup();
    expect(data.manager).toBe('settings');
    expect(data.payload).toBeUndefined();
  });
});

describe('coerceToShippedType — the stored value keeps the shipped default\'s type', () => {
  it('booleans, numbers, lists and text', () => {
    expect(coerceToShippedType('true', false)).toBe(true);
    expect(() => coerceToShippedType('yes', false)).toThrow('expected true or false');
    expect(coerceToShippedType('42', 0)).toBe(42);
    expect(() => coerceToShippedType('', 0)).toThrow('expected a number');
    expect(() => coerceToShippedType(true, 0)).toThrow('expected a number');
    expect(coerceToShippedType('a, b,,c', [])).toEqual(['a', 'b', 'c']);
    expect(coerceToShippedType([1, 2], [])).toEqual(['1', '2']);
    expect(() => coerceToShippedType(1, [])).toThrow('expected a list');
    expect(coerceToShippedType(7, '')).toBe('7');
    expect(() => coerceToShippedType({}, '')).toThrow('expected text');
  });
});
