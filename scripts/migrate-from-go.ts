/**
 * `npm run migrate:go` — the migration from a source checkout.
 *
 * The command itself lives in `src/cli/migrate.ts` and ships in the image (yourphr#654); this is
 * the development entry point onto exactly the same code. One implementation: a harness that
 * exercised a copy here would be proving something the image does not run.
 *
 *   npm run migrate:go -- --go <go.db> --data <data dir> [flags]
 *
 * Run `npm run migrate:go` with no flags for the full usage.
 */
import '../src/bootstrap-env.js';
import { migrate } from '../src/cli/migrate.js';

migrate(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err: Error) => {
    console.error(`migration failed: ${err.message}`);
    process.exit(1);
  });
