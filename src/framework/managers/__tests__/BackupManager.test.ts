import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../Engine.js';
import { ApiContext } from '../../ApiContext.js';
import { ConfigurationManager } from '../../ConfigurationManager.js';
import { ConfigStore } from '../../../config/index.js';
import { BackupManager, applyStagedRestore, type BackupExporter } from '../BackupManager.js';
import { FakeBackupProvider } from '../../providers/__tests__/FakeBackupProvider.js';
import { NullBackupProvider, type BaseBackupProvider } from '../../providers/BaseBackupProvider.js';
import type { BackupData } from '../../BaseManager.js';

/** The PHI store's door, scripted: "writes" a file name the fake store then lists. */
class FakeExporter implements BackupExporter {
  backups: { destination: string; key: string }[] = [];
  restores: { file: string; key: string }[] = [];
  fail = false;
  constructor(private readonly store: FakeBackupProvider) {}
  async backup(options: { destination: string; key: string; now?: Date }): Promise<BackupData & { file: string; sizeBytes: number; pruned: string[] }> {
    if (this.fail) throw new Error('disk full');
    this.backups.push({ destination: options.destination, key: options.key });
    const name = `${(options.now ?? new Date()).toISOString().replace(/:/g, '-')}-backup.db`;
    this.store.add(options.destination, name, 42);
    return { manager: 'records', takenAt: 'now', file: `${options.destination}/${name}`, sizeBytes: 42, pruned: [] };
  }
  async restore(data: BackupData, options: { key: string }): Promise<void> {
    this.restores.push({ file: data.files![0]!, key: options.key });
  }
}

let dir: string;
let engine: Engine;
let store: FakeBackupProvider;
let exporter: FakeExporter;
let backups: BackupManager;
let admin: ApiContext;
let alice: ApiContext;
let clock: Date;

async function boot(provider: BaseBackupProvider = store, env: Record<string, string> = { SPIKE_BACKUP_ENCRYPTION_KEY: 'travel-key' }): Promise<void> {
  engine = new Engine();
  exporter = new FakeExporter(store);
  backups = new BackupManager(engine, provider, { dataDir: dir, exporter, alsoExport: ['app-db'], now: () => clock });
  engine.register('configuration', new ConfigurationManager(engine, new ConfigStore(dir, undefined, env))).register('backups', backups);
  await engine.initialize();
  admin = ApiContext.from({ username: 'root', role: 'admin' }, engine);
  alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spike-backups-spec-'));
  clock = new Date('2026-04-01T02:00:30Z');
  store = new FakeBackupProvider();
  await boot();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('BackupManager — the coordinator', () => {
  it('boots after configuration, initialises its store, and defaults the destination under the data directory', () => {
    expect(engine.registered).toEqual(['configuration', 'backups']);
    expect(store.initialized).toBe(true);
    expect(backups.destination()).toBe(join(dir, 'backups'));
    expect(backups.unavailable()).toBe('');
  });

  it('a backup now goes through the exporter under the backup key, prunes by retention, and records a success', async () => {
    engine.managers.configuration.set('backup.max-backups', 2);
    await expect(backups.backupNow(alice)).rejects.toMatchObject({ status: 403 });
    const first = await backups.backupNow(admin);
    expect(first).toMatchObject({ name: expect.stringMatching(/backup\.db$/), sizeBytes: 42, pruned: [] });
    expect(exporter.backups).toEqual([{ destination: join(dir, 'backups'), key: 'travel-key' }]);
    expect(store.prepared).toEqual([join(dir, 'backups')]);
    clock = new Date('2026-04-02T02:00:30Z');
    await backups.backupNow(ApiContext.system('scheduler', 'scheduler', engine));
    clock = new Date('2026-04-03T02:00:30Z');
    const third = await backups.backupNow(admin);
    expect(third.pruned).toHaveLength(1);
    expect(await backups.list(admin)).toHaveLength(2);
    expect(backups.health()).toMatchObject({ ok: true, consecutive_failures: 0, last_success_path: third.file, days_since_success: 0, summary: expect.stringContaining('Scheduled backups are off') });
    expect(JSON.parse(readFileSync(join(dir, '.backup_health.json'), 'utf8'))).toMatchObject({ lastSuccessPath: third.file, consecutiveFailures: 0 });
  });

  it('refuses loudly without a key, and a failed export is recorded as a failure the health reports', async () => {
    await boot(store, {});
    expect(backups.unavailable()).toContain('no backup encryption key');
    await expect(backups.backupNow(admin)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('no backup encryption key') });
    expect(backups.health()).toMatchObject({ ok: false, consecutive_failures: 1 });
    await boot(); // the health file survives a restart: the refusal above still counts
    exporter.fail = true;
    await expect(backups.backupNow(admin)).rejects.toThrow('disk full');
    await expect(backups.backupNow(admin)).rejects.toThrow('disk full');
    expect(backups.health()).toMatchObject({ ok: false, consecutive_failures: 3, last_error: 'disk full', summary: 'No scheduled backups; none taken yet.' }); // Go's summary speaks of the schedule first; the failure count and error carry the rest
    expect(store.prepared).toHaveLength(2);
  });

  it('the Null store: the instance boots, every action refuses with the reason, nothing is listed', async () => {
    await boot(new NullBackupProvider());
    expect(backups.unavailable()).toContain('backup.storage.provider = null');
    await expect(backups.backupNow(admin)).rejects.toMatchObject({ status: 400 });
    expect(await backups.list(admin)).toEqual([]);
    expect(await backups.testDestination(admin, '/mnt/nas')).toMatchObject({ writable: false });
    await expect(backups.browse(admin, '/')).rejects.toMatchObject({ status: 400 });
    await expect(backups.stageRestore(admin, 'x-backup.db')).rejects.toMatchObject({ status: 404 });
  });

  it('validates the schedule as Go does and stores it; due() follows the minute, the weekday, and fires once per minute', async () => {
    expect(() => backups.setSchedule(alice, {})).toThrow('admin role required');
    expect(() => backups.setSchedule(admin, { time: '2:00', days: 'daily' })).toThrow('time must be HH:MM (24-hour)');
    expect(() => backups.setSchedule(admin, { time: '02:00', days: 'monthly' })).toThrow("days must be 'daily' or 'weekly'");
    expect(() => backups.setSchedule(admin, { time: '02:00', days: 'daily', max_backups: -1 })).toThrow('max_backups must be a non-negative integer');
    expect(() => backups.setSchedule(admin, { time: '02:00', days: 'daily', destination: 'relative' })).toThrow('destination must be an absolute folder, or empty for the default');
    expect(backups.setSchedule(admin, { enabled: true, time: '02:00', days: 'weekly', destination: '/mnt/nas', max_backups: 3 })).toEqual({ enabled: true, time: '02:00', days: 'weekly', destination: '/mnt/nas', max_backups: 3 });
    expect(backups.destination()).toBe('/mnt/nas');
    const sunday = new Date(2026, 3, 5, 2, 0, 10); // 2026-04-05 is a Sunday, server-local 02:00
    const monday = new Date(2026, 3, 6, 2, 0, 10);
    expect(backups.due(monday)).toBe(false);
    expect(backups.due(sunday)).toBe(true);
    expect(backups.due(sunday, sunday.toISOString().slice(0, 16))).toBe(false);
    expect(backups.due(new Date(2026, 3, 5, 2, 1, 0))).toBe(false);
    backups.setSchedule(admin, { enabled: false, time: '02:00', days: 'daily' });
    expect(backups.due(sunday)).toBe(false);
  });

  it('health says stale when a schedule is on and nothing has succeeded recently', async () => {
    backups.setSchedule(admin, { enabled: true, time: '02:00', days: 'daily' });
    expect(backups.health()).toMatchObject({ ok: false, failing_stale: true, summary: 'Scheduled backups are on but none has succeeded recently.' });
    await backups.backupNow(admin);
    expect(backups.health()).toMatchObject({ ok: true, failing_stale: false, summary: expect.stringContaining('Healthy') });
    clock = new Date('2026-04-05T02:00:30Z');
    expect(backups.health()).toMatchObject({ ok: false, failing_stale: true, days_since_success: 4 });
  });

  it('a restore backs the live instance up FIRST, then stages the named backup through the exporter under the backup key', async () => {
    await expect(backups.stageRestore(admin, '../etc/passwd')).rejects.toMatchObject({ status: 404 });
    const taken = await backups.backupNow(admin);
    clock = new Date('2026-04-01T03:00:00Z');
    const r = await backups.stageRestore(admin, taken.name);
    expect(r).toMatchObject({ staged: true });
    expect(exporter.backups).toHaveLength(2);
    expect(exporter.restores).toEqual([{ file: taken.file, key: 'travel-key' }]);
    expect(await backups.testDestination(admin, '')).toEqual({ destination: join(dir, 'backups'), writable: true });
    expect(await backups.browse(admin, '/')).toMatchObject({ dirs: ['a', 'b'] });
  });

  it('applyStagedRestore swaps staged files in by rename, keeping the previous live file', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(dir, 'records.db'), 'live');
    writeFileSync(join(dir, 'records.db.staged'), 'staged');
    const lines: string[] = [];
    applyStagedRestore(dir, [['records.db.staged', 'records.db'], ['spike.db.staged', 'spike.db']], (l) => lines.push(l));
    expect(readFileSync(join(dir, 'records.db'), 'utf8')).toBe('staged');
    expect(readFileSync(join(dir, 'records.db.pre-restore'), 'utf8')).toBe('live');
    expect(existsSync(join(dir, 'spike.db'))).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('its own backup is the health state, and restoring it rewrites the file', async () => {
    await backups.backupNow(admin);
    const own = await backups.backup();
    expect(own).toMatchObject({ manager: 'backups', payload: { consecutiveFailures: 0 } });
    await boot();
    await backups.restore(own);
    expect(backups.health().last_success_at).toBe('2026-04-01T02:00:30.000Z');
  });
});
