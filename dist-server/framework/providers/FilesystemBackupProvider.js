/** Backup artifacts on a local folder (yourphr#615) — a NAS mount, a USB stick, the data directory. */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BaseBackupProvider } from './BaseBackupProvider.js';
export class FilesystemBackupProvider extends BaseBackupProvider {
    suffix;
    name = 'filesystem';
    /** What one of our artifacts is called — the suffix the export writes. */
    constructor(suffix) {
        super();
        this.suffix = suffix;
    }
    async initialize() { }
    async ensure(destination) {
        mkdirSync(destination, { recursive: true });
    }
    async list(destination) {
        if (!existsSync(destination))
            return [];
        return readdirSync(destination)
            .filter((f) => f.endsWith(this.suffix))
            .sort()
            .reverse()
            .map((name) => {
            const st = statSync(join(destination, name));
            return { name, sizeBytes: st.size, modified: st.mtime.toISOString() };
        });
    }
    isArtifactName(name) {
        return name.endsWith(this.suffix) && !name.includes('/') && !name.includes('\\') && !name.includes('..');
    }
    async resolve(destination, name) {
        if (!this.isArtifactName(name))
            return undefined;
        const file = join(destination, name);
        return existsSync(file) ? file : undefined;
    }
    async prune(destination, keep) {
        if (keep <= 0)
            return [];
        const pruned = [];
        for (const old of (await this.list(destination)).slice(keep)) {
            unlinkSync(join(destination, old.name));
            pruned.push(old.name);
        }
        return pruned;
    }
    async testDestination(destination) {
        try {
            if (!existsSync(destination))
                throw new Error('folder does not exist');
            const probe = join(destination, `.yourphr-write-test-${process.pid}`);
            writeFileSync(probe, 'ok\n');
            unlinkSync(probe);
            return { destination, writable: true };
        }
        catch (err) {
            return { destination, writable: false, error: err.message };
        }
    }
    async browse(path) {
        const p = resolve(path.trim() || '/');
        if (!existsSync(p) || !statSync(p).isDirectory())
            throw new Error(`cannot read ${JSON.stringify(p)}: not a directory`);
        const dirs = readdirSync(p, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
            .map((d) => d.name)
            .sort();
        const parent = dirname(p) === p ? '' : dirname(p);
        return { path: p, parent, dirs };
    }
}
//# sourceMappingURL=FilesystemBackupProvider.js.map