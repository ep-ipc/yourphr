import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemBackupProvider } from '../FilesystemBackupProvider.js';

let dir: string;
let fs: FilesystemBackupProvider;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spike-fsbackup-spec-'));
  fs = new FilesystemBackupProvider('-backup.db');
  await fs.initialize();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FilesystemBackupProvider — artifacts on a folder', () => {
  it('prepares a destination, lists only our artifacts newest first, resolves safe names only, prunes by count', async () => {
    const dest = join(dir, 'backups');
    expect(await fs.list(dest)).toEqual([]);
    await fs.ensure(dest);
    for (const n of ['2026-01-01T00-00-00Z-backup.db', '2026-01-03T00-00-00Z-backup.db', '2026-01-02T00-00-00Z-backup.db', 'notes.txt']) writeFileSync(join(dest, n), 'x');
    expect((await fs.list(dest)).map((a) => a.name)).toEqual(['2026-01-03T00-00-00Z-backup.db', '2026-01-02T00-00-00Z-backup.db', '2026-01-01T00-00-00Z-backup.db']);
    expect(await fs.resolve(dest, '2026-01-02T00-00-00Z-backup.db')).toBe(join(dest, '2026-01-02T00-00-00Z-backup.db'));
    expect(await fs.resolve(dest, '../2026-01-02T00-00-00Z-backup.db')).toBeUndefined();
    expect(await fs.resolve(dest, 'notes.txt')).toBeUndefined();
    expect(await fs.resolve(dest, 'missing-backup.db')).toBeUndefined();
    expect(await fs.prune(dest, 0)).toEqual([]);
    expect(await fs.prune(dest, 2)).toEqual(['2026-01-01T00-00-00Z-backup.db']);
    expect(existsSync(join(dest, '2026-01-01T00-00-00Z-backup.db'))).toBe(false);
  });

  it('proves a destination by writing and removing a probe; a missing folder is not writable', async () => {
    expect(await fs.testDestination(join(dir, 'nope'))).toMatchObject({ writable: false, error: 'folder does not exist' });
    expect(await fs.testDestination(dir)).toEqual({ destination: dir, writable: true });
  });

  it('browses one level of folders, hiding dotfolders, with a parent except at the root', async () => {
    mkdirSync(join(dir, 'b'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, 'file'), '');
    expect(await fs.browse(dir)).toMatchObject({ path: dir, dirs: ['a', 'b'] });
    expect((await fs.browse('/')).parent).toBe('');
    await expect(fs.browse(join(dir, 'file'))).rejects.toThrow(/not a directory/);
  });
});
