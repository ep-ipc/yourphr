/**
 * Loads `.env` into process.env before anything else runs (yourphr#630).
 *
 * Ported from ngdpbase's `src/bootstrap-env.ts`, which exists for a reason this stack has too:
 * `server.sh` sources .env for a direct install, but a container runs `node dist/main.js` and
 * never sources anything — so a `.env` sitting on the data volume was silently inert, and a secret
 * could only reach the process through a Kubernetes Secret plus an `env:` block in the manifest.
 * That is the wrong home for application configuration and a GitOps change to alter.
 *
 * MUST be the first import in the entry point. ES module imports are hoisted and evaluated in
 * order, so a side-effecting module imported first is the only reliable way to populate the
 * environment ahead of every other module's top-level code. Calling `dotenv.config()` inline in
 * main.ts would run AFTER all of its imports had already been evaluated.
 *
 * Precedence, highest first:
 *
 *   1. The ambient environment      — Kubernetes `env:`, `PORT=x node …`, a shell export
 *   2. `<FAST_STORAGE>/.env`        — per-instance, lives on the data volume with the records
 *   3. `<cwd>/.env`                 — the repo root, for a direct install
 *
 * The ambient environment wins so an explicitly-set variable is never silently overridden by a
 * file. That ordering is also what makes the migration off the Kubernetes Secret safe: while the
 * Secret is still in the manifest it keeps winning, so the file can be put in place and verified
 * before the Secret is removed.
 *
 * The per-instance file is applied before the root one so it takes precedence between the two. Its
 * location can itself be declared in the root file, so that file is PARSED (not applied) first
 * purely to discover YOURPHR_FAST_STORAGE.
 */
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
const rootEnvPath = path.join(process.cwd(), '.env');
/**
 * Where the per-instance .env lives. The fast root may be set ambiently or declared in the root
 * .env, so peek at that file without applying it. `./data` is the default, which is what makes an
 * unpacked copy run without an operator setting anything (ngdpbase ships the same default).
 */
function resolveFastStorage() {
    if (process.env['YOURPHR_FAST_STORAGE'])
        return process.env['YOURPHR_FAST_STORAGE'];
    // Pre-yourphr#630 name, still honoured so an existing deployment keeps booting.
    if (process.env['YOURPHR_STORAGE_DATA_DIR'])
        return process.env['YOURPHR_STORAGE_DATA_DIR'];
    try {
        const parsed = dotenv.parse(fs.readFileSync(rootEnvPath));
        return parsed['YOURPHR_FAST_STORAGE'] || parsed['YOURPHR_STORAGE_DATA_DIR'] || './data';
    }
    catch {
        return './data';
    }
}
// Per-instance first so it beats the root file; neither overrides the ambient environment.
dotenv.config({ path: path.join(resolveFastStorage(), '.env'), quiet: true });
dotenv.config({ path: rootEnvPath, quiet: true });
//# sourceMappingURL=bootstrap-env.js.map