/**
 * Build the demo's baked-in baseline (yourphr#645): the two databases a public demo is reset to.
 *
 *   npx tsx scripts/build-demo-baseline.ts --out ./baseline
 *
 * Runs in the IMAGE BUILD, not on an operator's machine, so what ships is reproducible and nobody
 * hand-curates a database that strangers will read. Everything in it is SYNTHETIC — generated here
 * from the same fake provider the harnesses use. That is the never-commingle rule (yourphr test-data
 * policy) at its sharpest: this is the one instance the public can read.
 *
 * What it contains, and why each part is needed:
 *   - the demo account, so the one-click entrance has something to sign in to (yourphr#643);
 *   - the bootstrap admin, because an instance with users and no admin is administrable by nobody;
 *   - a connected source and its records, so a visitor lands on a populated PHR rather than the
 *     empty one that made the Go demo useless to evaluate (yourphr#494).
 *
 * NO credentials are baked in. Both passwords are provisioned at startup — the demo's by demo mode
 * (yourphr#515's rule, generated per instance), the admin's by bootstrap provisioning — so an image
 * that anyone can pull carries no password that works anywhere.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assembleApp } from '../src/app.js';
import { ApiContext } from '../src/framework/ApiContext.js';
import { BASELINE_APP, BASELINE_RECORDS, baselineIsPresent } from '../src/demo/reset.js';
import { startFakeProvider } from './lib/fake-provider.js';

const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
const outDir = resolve(at === -1 ? './baseline' : (argv[at + 1] ?? './baseline'));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'yourphr-baseline-'));
  const fake = startFakeProvider('tok');
  const fakeBase = await new Promise<string>((resolve_) => {
    fake.listen(0, '127.0.0.1', () => resolve_(`http://127.0.0.1:${(fake.address() as { port: number }).port}`));
  });

  // A baseline is PLAINTEXT by necessity: it ships in a public image, and the reset refuses to
  // install it over an encrypted instance precisely because there would be no key to write it with.
  const app = await assembleApp(dir, {
    version: 'baseline',
    env: { YOURPHR_DATABASE_ENCRYPTION_KEY: '', YOURPHR_BACKUP_ENCRYPTION_KEY: 'unused-by-this-build', SPIKE_TEST_ALLOW_INTERNAL: '1' },
  });

  const demoUser = 'demo';
  const sys = ApiContext.system('baseline-build', 'admin', app.engine);
  await app.users.createUser(sys, demoUser, 'replaced-at-startup-by-demo-provisioning');

  await app.sources.add(ApiContext.system('baseline-build', demoUser, app.engine), {
    userId: demoUser, display: 'Sample Regional Health', fhirBaseUrl: fakeBase, tokenUrl: `${fakeBase}/token`,
    clientId: 'baseline', patient: 'pa', resourceTypes: ['Condition', 'MedicationStatement'],
    accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999, platformType: 'ehr', environment: 'sandbox',
  });
  await app.syncNow(1_000_000);

  const held = await app.engine.managers.records.typesHeld(ApiContext.system('baseline-build', demoUser, app.engine));
  await app.close();
  fake.close();

  if (held.length === 0) throw new Error('baseline: the sync produced no records — a demo with an empty account is the bug this exists to prevent');

  mkdirSync(outDir, { recursive: true });
  cpSync(join(dir, 'spike.db'), join(outDir, BASELINE_APP));
  cpSync(join(dir, 'records.db'), join(outDir, BASELINE_RECORDS));
  rmSync(dir, { recursive: true, force: true });

  if (!baselineIsPresent(outDir)) throw new Error(`baseline: nothing usable was written to ${outDir}`);
  console.log(`baseline written to ${outDir}: ${BASELINE_APP} + ${BASELINE_RECORDS}, holding ${held.join(', ')} for ${demoUser}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
