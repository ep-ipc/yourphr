/**
 * Backups (yourphr#615): the coordinator — when a backup runs, where it goes, whether it worked,
 * and how a restore is staged. The encrypted export is the PHI store's own (the component holding
 * the key is the only one that can export correctly): this manager asks the exporter through its
 * door and records the outcome either way (yourphr#441 — an invisible backup is indistinguishable
 * from a broken one). Storage is OPTIONAL (decision Q6): with the Null provider the instance serves
 * and every backup action refuses with a reason; the boot never fails for a missing backup store.
 *
 * Known gap the doc names: one exporter today, so the snapshot is consistent; with several, the
 * per-manager backup() contract yields a torn snapshot and quiescing is engine-level work still to design.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BaseManager } from '../BaseManager.js';
import { ApiError } from '../ApiContext.js';
/**
 * Applies a staged restore at start, BEFORE anything opens: each staged file's live counterpart
 * steps aside as *.pre-restore and the staged file takes its name. A rename, never a write into a
 * live database. The application names the pairs — which files its stores stage.
 */
export function applyStagedRestore(dataDir, pairs, log) {
    for (const [staged, live] of pairs) {
        const stagedPath = join(dataDir, staged);
        if (!existsSync(stagedPath))
            continue;
        const livePath = join(dataDir, live);
        if (existsSync(livePath))
            renameSync(livePath, `${livePath}.pre-restore`);
        renameSync(stagedPath, livePath);
        log(`restore applied: ${staged} -> ${live} (previous kept as ${live}.pre-restore)`);
    }
}
export class BackupManager extends BaseManager {
    provider;
    options;
    name = 'backups';
    dependsOn = ['configuration'];
    healthFile;
    state = { consecutiveFailures: 0 };
    constructor(engine, provider, options) {
        super(engine);
        this.provider = provider;
        this.options = options;
        this.healthFile = join(options.dataDir, '.backup_health.json');
    }
    async initialize(config = {}) {
        await super.initialize(config);
        await this.provider.initialize();
        if (existsSync(this.healthFile)) {
            try {
                this.state = JSON.parse(readFileSync(this.healthFile, 'utf8'));
            }
            catch { /* unreadable: start clean, the next outcome rewrites it */ }
        }
    }
    now() { return this.options.now?.() ?? new Date(); }
    get cfg() { return this.engine.managers.configuration; }
    /** The admin's, or the scheduler acting as a system principal. */
    manage(ctx) {
        if (ctx.system === '')
            ctx.require('admin-system');
    }
    // --- where and when ----------------------------------------------------------------------
    destination() {
        // Composed from a storage root in the configuration file, not joined here (yourphr#626).
        return this.cfg.getString('yourphr.backup.destination') || join(this.options.dataDir, 'backups');
    }
    schedule() {
        const c = this.cfg;
        return { enabled: c.getBool('yourphr.backup.schedule.enabled'), time: c.getString('yourphr.backup.schedule.time'), days: c.getString('yourphr.backup.schedule.days'), destination: c.getString('yourphr.backup.destination'), max_backups: c.getInt('yourphr.backup.max-backups') };
    }
    /** Go's validation, then the settings store — refusals name the rule. */
    setSchedule(ctx, req) {
        this.manage(ctx);
        const time = String(req.time ?? '').trim();
        const days = String(req.days ?? '').trim().toLowerCase();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
            throw new ApiError(400, 'time must be HH:MM (24-hour)');
        if (days !== 'daily' && days !== 'weekly')
            throw new ApiError(400, "days must be 'daily' or 'weekly'");
        const maxBackups = Number(req.max_backups ?? 0);
        if (!Number.isInteger(maxBackups) || maxBackups < 0)
            throw new ApiError(400, 'max_backups must be a non-negative integer');
        const destination = String(req.destination ?? '').trim();
        if (destination !== '' && !destination.startsWith('/'))
            throw new ApiError(400, 'destination must be an absolute folder, or empty for the default');
        const c = this.cfg;
        c.set('yourphr.backup.schedule.enabled', req.enabled === true);
        c.set('yourphr.backup.schedule.time', time);
        c.set('yourphr.backup.schedule.days', days);
        c.set('yourphr.backup.destination', destination);
        c.set('yourphr.backup.max-backups', maxBackups);
        return this.schedule();
    }
    /** Due now? Go's rule: the minute matches, weekly only on Sundays, at most once per minute. */
    due(now = this.now(), lastRun) {
        const s = this.schedule();
        if (!s.enabled)
            return false;
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (hhmm !== s.time)
            return false;
        if (s.days === 'weekly' && now.getDay() !== 0)
            return false;
        return lastRun !== now.toISOString().slice(0, 16);
    }
    /** Why backups cannot be taken, or '' — this stack always encrypts, so the key is one gate; the store is the other. */
    unavailable() {
        if (this.provider.name === 'null')
            return 'Backups are unavailable: no backup storage is configured (backup.storage.provider = null).';
        if (this.cfg.getString('yourphr.backup.encryption.key') === '') {
            return 'Backups are unavailable: no backup encryption key is set (YOURPHR_BACKUP_ENCRYPTION_KEY). Backups are always encrypted, so there is nothing safe to write.';
        }
        return '';
    }
    // --- the actions ----------------------------------------------------------------------------
    /** A backup now: the instance in one encrypted file through the exporter's door; the outcome recorded either way. */
    async backupNow(ctx, destination = this.destination()) {
        this.manage(ctx);
        const at = this.now().toISOString();
        try {
            const reason = this.unavailable();
            if (reason !== '')
                throw new ApiError(400, reason);
            await this.provider.ensure(destination);
            const result = await this.options.exporter.backup({ destination, key: this.cfg.getString('yourphr.backup.encryption.key'), now: this.now(), alsoExport: this.options.alsoExport });
            const pruned = await this.provider.prune(destination, this.cfg.getInt('yourphr.backup.max-backups'));
            this.state = { lastSuccessAt: at, lastSuccessPath: result.file, lastAttemptAt: at, consecutiveFailures: 0 };
            this.saveHealth();
            return { file: result.file, name: basename(result.file), sizeBytes: result.sizeBytes, pruned };
        }
        catch (err) {
            this.state = { ...this.state, lastAttemptAt: at, lastError: err.message, consecutiveFailures: this.state.consecutiveFailures + 1 };
            this.saveHealth();
            throw err;
        }
    }
    saveHealth() {
        writeFileSync(this.healthFile, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    }
    health() {
        const s = this.schedule();
        const h = this.state;
        const days = h.lastSuccessAt ? Math.floor((this.now().getTime() - Date.parse(h.lastSuccessAt)) / 86_400_000) : undefined;
        const overdueAfter = s.days === 'weekly' ? 8 : 2;
        const failingStale = s.enabled && (days === undefined || days > overdueAfter);
        const ok = !failingStale && h.consecutiveFailures === 0;
        let summary;
        if (!s.enabled && !h.lastSuccessAt)
            summary = 'No scheduled backups; none taken yet.';
        else if (!s.enabled)
            summary = `Scheduled backups are off; last backup ${h.lastSuccessAt}.`;
        else if (h.consecutiveFailures > 0)
            summary = `The last ${h.consecutiveFailures} attempt(s) failed: ${h.lastError ?? ''}`;
        else if (failingStale)
            summary = 'Scheduled backups are on but none has succeeded recently.';
        else
            summary = `Healthy — last backup ${h.lastSuccessAt}.`;
        return {
            ok,
            schedule_enabled: s.enabled,
            destination: this.destination(),
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
    list(ctx) {
        this.manage(ctx);
        return this.provider.list(this.destination());
    }
    testDestination(ctx, destination) {
        this.manage(ctx);
        return this.provider.testDestination(destination.trim() || this.destination());
    }
    async browse(ctx, path) {
        this.manage(ctx);
        try {
            return await this.provider.browse(path);
        }
        catch (err) {
            throw new ApiError(400, err.message);
        }
    }
    /**
     * Stage a restore from a backup in the destination: the live databases are backed up FIRST so the
     * swap is reversible, then both halves are exported under the live keys into <data>/*.staged for
     * the next start (applyStagedRestore). The live files are never touched here.
     */
    async stageRestore(ctx, backupName) {
        this.manage(ctx);
        const file = await this.provider.resolve(this.destination(), backupName);
        if (!file)
            throw new ApiError(404, 'no such backup in the destination folder');
        await this.backupNow(ctx);
        await this.options.exporter.restore({ manager: 'backups', takenAt: this.now().toISOString(), files: [file] }, { key: this.cfg.getString('yourphr.backup.encryption.key') });
        return { staged: true, message: 'Restore staged (current databases backed up first). Restart the app to apply it.' };
    }
    /** The coordinator keeps no data of its own; the health file is derived and rewritten by the next outcome. */
    async backup() {
        return { manager: this.name, takenAt: this.now().toISOString(), payload: this.state };
    }
    async restore(data) {
        if (data.payload) {
            this.state = data.payload;
            this.saveHealth();
        }
    }
}
//# sourceMappingURL=BackupManager.js.map