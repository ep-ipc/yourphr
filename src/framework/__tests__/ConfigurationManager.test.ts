import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../Engine.js';
import { ConfigurationManager, deepMerge } from '../ConfigurationManager.js';
import { FakeConfigProvider } from '../providers/__tests__/FakeConfigProvider.js';
import { FileConfigProvider } from '../providers/FileConfigProvider.js';
import type { ConfigValue } from '../../config/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'spike-cfg-')); dirs.push(d); return d; };

function boot(env: Record<string, string> = {}, custom: Record<string, ConfigValue> = {}) {
  const engine = new Engine();
  const provider = new FakeConfigProvider(custom);
  const cfg = new ConfigurationManager(engine, provider, { env });
  engine.register('configuration', cfg);
  return { engine, cfg, provider };
}

describe('ConfigurationManager — the door; the provider only stores (yourphr#621)', () => {
  it('merges the two layers and answers with the typed getters', async () => {
    const { engine, cfg } = boot();
    await engine.initialize();
    expect(cfg.getInt('sync.max-pages')).toBe(500);
    expect(cfg.getBool('backup.schedule.enabled')).toBe(false);
    expect(cfg.getStringList('auth.trusted-proxies')).toEqual([]);
    cfg.set('sync.max-pages', 42);
    expect(cfg.getInt('sync.max-pages')).toBe(42);
  });

  it('writes ONLY the deltas — never the merged view (the ngdpbase #895 lesson)', async () => {
    const { engine, cfg, provider } = boot();
    await engine.initialize();
    cfg.set('operator.name', 'Ops');
    // The whole point: one changed key on disk, not a frozen copy of the 29 shipped ones.
    expect(provider.written()).toEqual({ 'operator.name': 'Ops' });
    expect(cfg.customValues()).toEqual({ 'operator.name': 'Ops' });
    expect(cfg.getInt('sync.max-pages')).toBe(500); // still following the product
  });

  it('a later release changing a shipped default reaches an instance that never overrode it', () => {
    const provider = new FakeConfigProvider({ 'operator.name': 'Ops' }, { ...shipped(), 'auth.throttle.max-failures': 8 });
    const cfg = new ConfigurationManager(new Engine(), provider, { env: {} });
    expect(cfg.getInt('auth.throttle.max-failures')).toBe(8); // the new default applies
    expect(cfg.getString('operator.name')).toBe('Ops');       // the override still wins
  });

  it('precedence is environment > instance override > shipped default', () => {
    const { cfg } = boot({ SPIKE_AUTH_PASSWORD_MIN_LENGTH: '20' }, { 'auth.password.min-length': 16 });
    expect(cfg.getInt('auth.password.min-length')).toBe(20);
    expect(cfg.isSetByEnvironment('auth.password.min-length')).toBe(true);
    expect(cfg.shippedValue('auth.password.min-length')).toBe(12); // what the product says, regardless
  });

  it('refuses the writes that would store a value that never applies', () => {
    const { cfg } = boot({ SPIKE_SYNC_MAX_PAGES: '9' });
    expect(() => cfg.set('nope.key', 1)).toThrow(/unknown configuration key/);
    expect(() => cfg.set('database.encryption.key', 'x')).toThrow(/bootstrap/);   // env only
    expect(() => cfg.set('sync.max-pages', 5)).toThrow(/set in the environment/); // env wins at read time
  });

  it('clear() drops an override; resetToDefaults() drops them all', async () => {
    const { engine, cfg, provider } = boot();
    await engine.initialize();
    cfg.set('operator.name', 'Ops');
    cfg.set('backup.max-backups', 3);
    expect(cfg.clear('operator.name')).toBe(true);
    expect(cfg.clear('operator.name')).toBe(false);
    expect(cfg.getString('operator.name')).toBe('');
    cfg.resetToDefaults();
    expect(provider.written()).toEqual({});
    expect(cfg.getInt('backup.max-backups')).toBe(7);
  });

  it('unknown override keys are reported, never silently carried or dropped (yourphr#473)', () => {
    const { cfg } = boot({}, { 'operator.name': 'Ops', 'typo.key': 'x' });
    expect(cfg.unknownKeys()).toEqual(['typo.key']);
  });

  it('unreadable overrides are reported and never overwritten', () => {
    const provider = new FakeConfigProvider({}, undefined, '/data/config/app-custom-config.json: bad JSON');
    const cfg = new ConfigurationManager(new Engine(), provider, { env: {} });
    expect(cfg.unknownKeys()[0]).toContain('unreadable');
    expect(() => cfg.set('operator.name', 'Ops')).toThrow(/refusing to overwrite/);
    expect(provider.saves).toBe(0);
  });

  it('snapshot() names the layer each value came from and masks secrets', () => {
    const { cfg } = boot({ SPIKE_BACKUP_ENCRYPTION_KEY: 'from-env' }, { 'operator.name': 'Ops' });
    const rows = Object.fromEntries(cfg.snapshot().map((r) => [r.key, r]));
    expect(rows['backup.encryption.key']).toMatchObject({ value: '••••', source: 'environment' });
    expect(rows['operator.name']).toMatchObject({ value: 'Ops', source: 'custom' });
    expect(rows['sync.max-pages']).toMatchObject({ value: 500, source: 'default' });
    expect(rows['sync.max-pages']?.description).toContain('paging'); // meaning came from the catalogue
  });

  it('refuses to boot when the shipped values and the catalogue disagree', () => {
    const { 'sync.max-pages': _dropped, ...missingOne } = shipped();
    expect(() => new ConfigurationManager(new Engine(), new FakeConfigProvider({}, missingOne), { env: {} }))
      .toThrow(/no shipped value for sync\.max-pages/);
    expect(() => new ConfigurationManager(new Engine(), new FakeConfigProvider({}, { ...shipped(), 'undescribed.key': 1 }), { env: {} }))
      .toThrow(/no description for undescribed\.key/);
  });

  it('backup() carries the overrides only — never the environment — and restore() puts them back', async () => {
    const { engine, cfg } = boot({ SPIKE_BACKUP_ENCRYPTION_KEY: 'from-env' });
    await engine.initialize();
    cfg.set('operator.name', 'Ops');
    const data = await cfg.backup();
    expect(data.payload).toEqual({ 'operator.name': 'Ops' });
    const second = boot();
    await second.engine.initialize();
    await second.cfg.restore(data);
    expect(second.cfg.getString('operator.name')).toBe('Ops');
  });
});

describe('FileConfigProvider — the two files (yourphr#621)', () => {
  it('reads the shipped defaults and the instance overrides, ignoring _ comment keys', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'app-custom-config.json'), JSON.stringify({ _comment: 'notes', 'operator.name': 'Ops' }));
    const loaded = new FileConfigProvider(dir).load();
    expect(loaded.custom).toEqual({ 'operator.name': 'Ops' }); // the comment is not a setting
    expect(loaded.defaults['sync.max-pages']).toBe(500);
    expect(loaded.defaults['_comment']).toBeUndefined();
  });

  it('missing overrides are normal; missing SHIPPED defaults refuse the boot', () => {
    const dir = tmp();
    expect(new FileConfigProvider(dir).load().custom).toEqual({});
    expect(() => new FileConfigProvider(dir, join(dir, 'nope.json')).load()).toThrow(/part of the product/);
  });

  it('unparseable overrides are reported, not clobbered', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'app-custom-config.json'), '{ not json');
    const loaded = new FileConfigProvider(dir).load();
    expect(loaded.customUnreadable).toContain('app-custom-config.json');
    expect(loaded.custom).toEqual({});
  });

  it('saves the deltas with a header warning against pasting the defaults in', () => {
    const dir = tmp();
    const provider = new FileConfigProvider(dir);
    provider.saveCustom({ 'operator.name': 'Ops' });
    const written = JSON.parse(readFileSync(provider.customLocation(), 'utf8')) as Record<string, unknown>;
    expect(written['operator.name']).toBe('Ops');
    expect(String(written['_comment'])).toContain('ONLY what this instance changed');
    expect(Object.keys(written)).toHaveLength(2); // the header and the one delta; nothing else
  });
});

describe('deepMerge — ngdpbase\'s merge, carried as-is', () => {
  it('merges objects per entry so one override does not freeze the rest', () => {
    const merged = deepMerge(
      { roles: { admin: ['a'], user: [], anonymous: [] } },
      { roles: { user: ['b'] } }
    );
    expect(merged['roles']).toEqual({ admin: ['a'], user: ['b'], anonymous: [] });
  });

  it('merges arrays of {id, …} by id, and replaces any other array wholesale', () => {
    expect(deepMerge({ p: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] }, { p: [{ id: 'b', v: 9 }, { id: 'c', v: 3 }] })['p'])
      .toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 9 }, { id: 'c', v: 3 }]);
    expect(deepMerge({ p: ['a', 'b'] }, { p: ['c'] })['p']).toEqual(['c']);
  });
});

function shipped(): Record<string, ConfigValue> {
  return new FakeConfigProvider().load().defaults;
}
