import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../Engine.js';
import { ConfigurationManager } from '../ConfigurationManager.js';
import { ConfigStore } from '../../config/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function boot(env: Record<string, string> = {}): { engine: Engine; cfg: ConfigurationManager } {
  const dir = mkdtempSync(join(tmpdir(), 'spike-cfg-')); dirs.push(dir);
  const engine = new Engine();
  const cfg = new ConfigurationManager(engine, new ConfigStore(dir, undefined, env));
  engine.register('configuration', cfg);
  return { engine, cfg };
}

describe('ConfigurationManager — the configuration store as the first manager', () => {
  it('reads through to the store with the typed getters and sets into the overlay', async () => {
    const { engine, cfg } = boot();
    await engine.initialize();
    expect(cfg.getInt('sync.max-pages')).toBe(500);
    cfg.set('sync.max-pages', 42);
    expect(cfg.getInt('sync.max-pages')).toBe(42);
    expect(cfg.getBool('backup.schedule.enabled')).toBe(false);
    expect(cfg.getStringList('auth.trusted-proxies')).toEqual([]);
  });

  it('backup() carries only the overlay — never the environment — and restore() puts it back', async () => {
    const { engine, cfg } = boot({ SPIKE_BACKUP_ENCRYPTION_KEY: 'from-env' });
    await engine.initialize();
    cfg.set('operator.name', 'Ops');
    const data = await cfg.backup();
    expect(data.manager).toBe('configuration');
    expect(data.payload).toEqual({ 'operator.name': 'Ops' });
    const second = boot();
    await second.engine.initialize();
    await second.cfg.restore(data);
    expect(second.cfg.getString('operator.name')).toBe('Ops');
  });
});
