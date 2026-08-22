/**
 * The admin dashboard's cards (yourphr#602): the Database card (facts, backups, the schedule, its
 * health, a staged restore), the Metrics card, the Logs page, the Instance card — each in Go's
 * shape over what this stack already keeps. Go's rules carry: a schedule time is HH:MM, days are
 * daily or weekly (weekly = Sundays), a restore is STAGED and applied on the next start, never on
 * top of a live database, and backup health is the last scheduled/manual outcome, persisted so a
 * restart does not forget a failure.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { ConfigStore } from '../config/index.js';
import type { SourcesManager } from '../app/managers/SourcesManager.js';
import { isBackupFileName, listBackups, stageRestore, type BackupResult } from '../backup/index.js';
import type { RecordsManager } from '../app/managers/RecordsManager.js';

export interface BackupSchedule {
  enabled: boolean;
  time: string;
  days: string;
  destination: string;
  max_backups: number;
}

export interface BackupHealth {
  ok: boolean;
  schedule_enabled: boolean;
  destination?: string;
  last_success_at?: string;
  last_success_path?: string;
  last_attempt_at?: string;
  last_error?: string;
  consecutive_failures: number;
  days_since_success?: number;
  failing_stale: boolean;
  summary: string;
}

/** Tables that live in records.db; everything else in a backup belongs to the app database. */
export const RECORDS_TABLES = new Set(['resources', 'resource_history', 'search_index']);
export const STAGED_RECORDS = 'records.db.staged';
export const STAGED_APP = 'spike.db.staged';

export interface AdminDeps {
  dataDir: string;
  config: ConfigStore;
  appDb: InstanceType<typeof Database>;
  /** The door to connected sources (yourphr#612): the database page counts through it. */
  sources: SourcesManager;
  /** The door to the records (yourphr#609): backup and integrity go through it. */
  records: RecordsManager;
  now?: () => Date;
}

export class AdminOps {
  private readonly healthFile: string;
  private health: { lastSuccessAt?: string; lastSuccessPath?: string; lastAttemptAt?: string; lastError?: string; consecutiveFailures: number };

  constructor(private readonly deps: AdminDeps) {
    this.healthFile = join(deps.dataDir, '.backup_health.json');
    this.health = { consecutiveFailures: 0 };
    if (existsSync(this.healthFile)) {
      try { this.health = JSON.parse(readFileSync(this.healthFile, 'utf8')) as typeof this.health; } catch { /* unreadable: start clean, the next outcome rewrites it */ }
    }
  }

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  backupDestination(): string {
    return this.deps.config.getString('backup.destination') || join(this.deps.dataDir, 'backups');
  }

  schedule(): BackupSchedule {
    const c = this.deps.config;
    return {
      enabled: c.getBool('backup.schedule.enabled'),
      time: c.getString('backup.schedule.time'),
      days: c.getString('backup.schedule.days'),
      destination: c.getString('backup.destination'),
      max_backups: c.getInt('backup.max-backups'),
    };
  }

  /** Go's validation, then the settings store — refusals name the rule. */
  setSchedule(req: Partial<BackupSchedule>): BackupSchedule {
    const time = String(req.time ?? '').trim();
    const days = String(req.days ?? '').trim().toLowerCase();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('time must be HH:MM (24-hour)');
    if (days !== 'daily' && days !== 'weekly') throw new Error("days must be 'daily' or 'weekly'");
    const maxBackups = Number(req.max_backups ?? 0);
    if (!Number.isInteger(maxBackups) || maxBackups < 0) throw new Error('max_backups must be a non-negative integer');
    const destination = String(req.destination ?? '').trim();
    if (destination !== '' && !destination.startsWith('/')) throw new Error('destination must be an absolute folder, or empty for the default');
    const c = this.deps.config;
    c.set('backup.schedule.enabled', req.enabled === true);
    c.set('backup.schedule.time', time);
    c.set('backup.schedule.days', days);
    c.set('backup.destination', destination);
    c.set('backup.max-backups', maxBackups);
    return this.schedule();
  }

  /** Why backups cannot be taken, or '' — this stack always encrypts, so the key is the gate. */
  backupsUnavailable(): string {
    return this.deps.config.getString('backup.encryption.key') === ''
      ? 'Backups are unavailable: no backup encryption key is set (SPIKE_BACKUP_ENCRYPTION_KEY). Backups are always encrypted, so there is nothing safe to write.'
      : '';
  }

  /** A backup now: the records AND the app database in one encrypted file; the outcome recorded either way. */
  async backupNow(destination = this.backupDestination()): Promise<BackupResult> {
    const at = this.now().toISOString();
    try {
      const result = await this.deps.records.backup({
        destination,
        key: this.deps.config.getString('backup.encryption.key'),
        maxBackups: this.deps.config.getInt('backup.max-backups'),
        alsoExport: [this.deps.appDb],
        now: this.now(),
      });
      this.health = { lastSuccessAt: at, lastSuccessPath: result.file, lastAttemptAt: at, consecutiveFailures: 0 };
      this.saveHealth();
      return result;
    } catch (err) {
      this.health = { ...this.health, lastAttemptAt: at, lastError: (err as Error).message, consecutiveFailures: this.health.consecutiveFailures + 1 };
      this.saveHealth();
      throw err;
    }
  }

  private saveHealth(): void {
    writeFileSync(this.healthFile, JSON.stringify(this.health, null, 2) + '\n', { mode: 0o600 });
  }

  backupHealth(): BackupHealth {
    const s = this.schedule();
    const h = this.health;
    const days = h.lastSuccessAt ? Math.floor((this.now().getTime() - Date.parse(h.lastSuccessAt)) / 86_400_000) : undefined;
    const overdueAfter = s.days === 'weekly' ? 8 : 2;
    const failingStale = s.enabled && (days === undefined || days > overdueAfter);
    const ok = !failingStale && h.consecutiveFailures === 0;
    let summary: string;
    if (!s.enabled && !h.lastSuccessAt) summary = 'No scheduled backups; none taken yet.';
    else if (!s.enabled) summary = `Scheduled backups are off; last backup ${h.lastSuccessAt}.`;
    else if (h.consecutiveFailures > 0) summary = `The last ${h.consecutiveFailures} attempt(s) failed: ${h.lastError ?? ''}`;
    else if (failingStale) summary = 'Scheduled backups are on but none has succeeded recently.';
    else summary = `Healthy — last backup ${h.lastSuccessAt}.`;
    return {
      ok,
      schedule_enabled: s.enabled,
      ...(this.backupDestination() ? { destination: this.backupDestination() } : {}),
      ...(h.lastSuccessAt ? { last_success_at: h.lastSuccessAt } : {}),
      ...(h.lastSuccessPath ? { last_success_path: h.lastSuccessPath } : {}),
      ...(h.lastAttemptAt ? { last_attempt_at: h.lastAttemptAt } : {}),
      ...(h.lastError && h.consecutiveFailures > 0 ? { last_error: h.lastError } : {}),
      consecutive_failures: h.consecutiveFailures,
      ...(days !== undefined ? { days_since_success: days } : {}),
      failing_stale: failingStale,
      summary,
    };
  }

  /** Go's DatabaseInfoResponse over this stack's two files. */
  async databaseInfo(): Promise<Record<string, unknown>> {
    const dataDir = this.deps.dataDir;
    const files = [join(dataDir, this.deps.config.getString('database.location')), join(dataDir, 'records.db')];
    const sizeBytes = files.reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);
    const users = (this.deps.appDb.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n;
    const sourcesCount = await this.deps.sources.count();
    const quick = (db: InstanceType<typeof Database>): boolean => {
      try { return String((db.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check ?? '').toLowerCase() === 'ok'; } catch { return false; }
    };
    const destination = this.backupDestination();
    return {
      location: files.join(' + '),
      encryption_enabled: this.deps.config.getString('database.encryption.key') !== '',
      size_bytes: sizeBytes,
      users,
      sources: sourcesCount,
      integrity_ok: quick(this.deps.appDb) && (await this.deps.records.integrityOk()),
      backup_destination: destination,
      backups: listBackups(destination).map((b) => ({ name: b.name, size_bytes: b.sizeBytes, modified: b.modified })),
      schedule: this.schedule(),
      backup_health: this.backupHealth(),
      allowed_backup_roots: [],
      backups_unavailable: this.backupsUnavailable(),
    };
  }

  /** Prove a destination before a schedule relies on it (the product's #468): a write, then its removal. */
  testDestination(destination: string): { destination: string; writable: boolean; error?: string } {
    const dest = destination.trim() || this.backupDestination();
    try {
      const probe = join(dest, `.yourphr-write-test-${process.pid}`);
      if (!existsSync(dest)) throw new Error('folder does not exist');
      writeFileSync(probe, 'ok\n');
      unlinkSync(probe);
      return { destination: dest, writable: true };
    } catch (err) {
      return { destination: dest, writable: false, error: (err as Error).message };
    }
  }

  /** The server-folder browser: one level, sorted, parent when there is one. Absolute paths only. */
  browse(path: string): { path: string; parent: string; dirs: string[] } {
    const p = resolve(path.trim() || '/');
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`cannot read ${JSON.stringify(p)}: not a directory`);
    const dirs = readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
    const parent = dirname(p) === p ? '' : dirname(p);
    return { path: p, parent, dirs };
  }

  /**
   * Stage a restore from a backup in the current destination: both halves are exported under the
   * live keys into <data>/*.staged, and the next start swaps them in (openStores applies them). The
   * live databases are not touched here; a backup of them is taken first so the swap is reversible.
   */
  async stageRestore(backupName: string): Promise<{ staged: boolean; message: string }> {
    if (!isBackupFileName(backupName)) throw new Error('no such backup in the destination folder');
    const file = join(this.backupDestination(), backupName);
    if (!existsSync(file)) throw new Error('no such backup in the destination folder');
    await this.backupNow();
    const key = this.deps.config.getString('backup.encryption.key');
    const dbKey = this.deps.config.getString('database.encryption.key');
    stageRestore(file, key, join(this.deps.dataDir, STAGED_RECORDS), dbKey, (t) => RECORDS_TABLES.has(t));
    stageRestore(file, key, join(this.deps.dataDir, STAGED_APP), dbKey, (t) => !RECORDS_TABLES.has(t));
    return { staged: true, message: 'Restore staged (current databases backed up first). Restart the app to apply it.' };
  }

  /** Due now? Go's rule: the minute matches, weekly only on Sundays, at most once per minute. */
  scheduleDue(now = this.now(), lastRun?: string): boolean {
    const s = this.schedule();
    if (!s.enabled) return false;
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm !== s.time) return false;
    if (s.days === 'weekly' && now.getDay() !== 0) return false;
    const minute = now.toISOString().slice(0, 16);
    return lastRun !== minute;
  }
}

/**
 * Applies a staged restore at start: the live file steps aside as *.pre-restore and the staged
 * file takes its place. Called before any database opens.
 */
export function applyStagedRestore(dataDir: string, databaseLocation: string, log: (line: string) => void): void {
  const pairs: [string, string][] = [[STAGED_RECORDS, 'records.db'], [STAGED_APP, databaseLocation]];
  for (const [staged, live] of pairs) {
    const stagedPath = join(dataDir, staged);
    if (!existsSync(stagedPath)) continue;
    const livePath = join(dataDir, live);
    if (existsSync(livePath)) renameSync(livePath, `${livePath}.pre-restore`);
    renameSync(stagedPath, livePath);
    log(`restore applied: ${staged} -> ${live} (previous kept as ${live}.pre-restore)`);
  }
}
