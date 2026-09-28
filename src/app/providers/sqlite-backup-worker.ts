/**
 * The backup export's thread (yourphr#787) — see backupFiles in sqlite-backup.ts. One job per
 * worker: export, report, exit.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { backupFilesSync, type BackupOptions, type DatabaseFile } from './sqlite-backup.js';

const { sources, options } = workerData as { sources: DatabaseFile[]; options: BackupOptions };
try {
  parentPort?.postMessage({ ok: true, result: backupFilesSync(sources, options) });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: (err as Error).message });
}
