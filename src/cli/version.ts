/**
 * The version this build reports — read from the package.json beside the compiled output, found by
 * walking UP rather than by counting directories (yourphr#652).
 *
 * `../package.json` was right while the entry point sat at dist/main.js and wrong the moment the
 * build output moved to dist/server/. It crash-looped the instance at import time, before anything
 * served, on a path that exists in the source tree and not in the image — the kind of mistake a
 * relative literal makes and a search does not.
 *
 * The search runs to the filesystem root rather than to a fixed number of levels. A hop count is
 * the same latent trap in a slower form: it is correct for exactly the directory depth it was
 * written at, and adding one level anywhere above (this file moved from src/ into src/cli/ for
 * yourphr#654) silently spends one of them. Nothing above an install root carries a package.json
 * this could mistake for its own, and finding none is not fatal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appLog } from '../log/index.js';

export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return (JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }).version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not fatal: an instance that cannot name its own version should still serve records. The banner
  // says 0.0.0-unknown, which is visibly wrong rather than quietly stale (yourphr#642's lesson).
  appLog.warn('could not find package.json beside the build output — reporting the version as 0.0.0-unknown');
  return '0.0.0-unknown';
}
