/**
 * `compact` — give back the space the records store wasted on identical history copies
 * (yourphr#781).
 *
 *   yourphr compact [--data <data dir>] [--dry-run] [--no-vacuum]
 *
 * Up to v3.7.2 every sync pass stored a full new copy of every record it received, changed or not
 * — 8.4 GB on a household with two test connections. v3.7.3 stopped the growth; this removes what
 * was already written. A shipped command rather than a one-off script, because every install that
 * ran those releases has the same bloat (decided by Jim, 2026-09-26).
 *
 * STOP THE SERVER FIRST. The work is synchronous and whole-file, and VACUUM rewrites the database:
 * a running server would be refused writes for the duration. Back up before running it. On
 * Kubernetes: scale the deployment to 0 and run this in a one-off pod on the same volume.
 *
 * --dry-run  counts what would be removed; changes nothing.
 * --no-vacuum  prunes but leaves the file its current size (VACUUM needs as much free disk as the
 *              database, and time); run again without it later.
 *
 * Like `reset-password`, deliberately not reachable from a route: the authority is being able to run
 * a process against the data directory.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStores } from '../app.js';
import { flag, has, unknownFlags } from './args.js';

const VALUED = ['--data'] as const;
const VALUELESS = ['--dry-run', '--no-vacuum'] as const;

export const COMPACT_USAGE = 'usage: yourphr compact [--data <data dir>] [--dry-run] [--no-vacuum]   (stop the server and back up first)';

const EX_USAGE = 2;
const EX_SOFTWARE = 70;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function compact(argv: string[]): Promise<number> {
  const unknown = unknownFlags(argv, VALUED, VALUELESS);
  if (unknown.length > 0) {
    console.error(`compact: unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${unknown.join(' ')}\n${COMPACT_USAGE}`);
    return EX_USAGE;
  }

  // The same default and pre-#630 fallback the server resolves; and like reset-password, only an
  // instance that already exists — a mistyped --data must not answer with a fresh empty database.
  const dataDir = resolve(flag(argv, '--data') ?? process.env['YOURPHR_FAST_STORAGE'] ?? process.env['YOURPHR_STORAGE_DATA_DIR'] ?? './data');
  if (!existsSync(dataDir)) {
    console.error(`compact: ${dataDir} does not exist — name the instance's data directory with --data`);
    return EX_USAGE;
  }

  const dryRun = has(argv, '--dry-run');
  const vacuum = !has(argv, '--no-vacuum');
  console.log(`compact: ${dryRun ? 'dry run on' : 'compacting'} ${dataDir} — the server must be stopped`);

  const stores = await openStores(dataDir, process.env);
  try {
    const r = await stores.records.compact({ dryRun, vacuum });
    console.log(`  records:            ${r.resources} (unchanged)`);
    console.log(`  history rows:       ${r.historyBefore} -> ${r.historyAfter}${dryRun ? ' (dry run: nothing removed)' : ''}`);
    console.log(`  identical copies:   ${r.duplicates}${dryRun ? ' would be removed' : ' removed'}`);
    console.log(`  current versions repointed to the first copy of their content: ${r.repointed}`);
    console.log(`  file size:          ${mb(r.bytesBefore)} -> ${mb(r.bytesAfter)}${r.vacuumed ? '' : dryRun ? '' : ' (not vacuumed; run again without --no-vacuum to reclaim)'}`);
    console.log(`  integrity:          ${r.integrity}`);
    if (r.integrity.toLowerCase() !== 'ok') {
      console.error('compact: the integrity check did not come back ok — restore the backup you took before running this');
      return EX_SOFTWARE;
    }
    return 0;
  } finally {
    await stores.close();
  }
}
