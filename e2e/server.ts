/**
 * The E2E backend (yourphr#610): one spike, booted the way the image boots it, serving the BUILT
 * Angular app, with a synthetic household and the fake FHIR provider. No PHI anywhere: the data
 * directory is a fresh temp dir, the accounts are invented, the records are the fake's.
 *
 * Playwright starts this as its webServer; it prints the admin bootstrap password into
 * e2e/.admin-pass (0600, gitignored) for the admin journeys.
 *
 *   SPIKE_E2E_WEB_DIR   the built Angular bundle (default /tmp/spike-web — what the audit uses)
 *   SPIKE_E2E_PORT      default 18111
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleApp } from '../src/app.js';
import { startFakeProvider, listenFake } from '../scripts/lib/fake-provider.js';
import { ADMIN_PASS_FILE, E2E_PASS, E2E_PORT, E2E_PW_PASS, E2E_PW_USER, E2E_RESET_PASS, E2E_RESET_USER, E2E_USER } from './constants.js';

const webDir = process.env['SPIKE_E2E_WEB_DIR'] ?? '/tmp/spike-web';
if (!existsSync(join(webDir, 'index.html'))) {
  console.error(`[e2e] no built Angular app at ${webDir} (index.html missing). Set SPIKE_E2E_WEB_DIR to the bundle — the image holds it at /opt/fasten/web.`);
  process.exit(78);
}

const dir = mkdtempSync(join(tmpdir(), 'spike-e2e-'));
const fake = startFakeProvider('tok');
const fakeBase = await listenFake(fake);

const app = await assembleApp(dir, {
  env: {
    SPIKE_DATABASE_ENCRYPTION_KEY: 'e2e-at-rest-key',
    SPIKE_BACKUP_ENCRYPTION_KEY: 'e2e-backup-key',
    SPIKE_TEST_ALLOW_INTERNAL: '1',
  },
  webDir,
  version: 'e2e',
  seeds: [{ display: 'Fake Regional Health', environment: 'sandbox', fhirBaseUrl: fakeBase, scopes: 'patient/Condition.read patient/MedicationStatement.read', clientId: 'fake-cid', enabled: true, allowInternal: true }],
});
writeFileSync(ADMIN_PASS_FILE, readFileSync(app.bootstrapPasswordFile!, 'utf8'), { mode: 0o600 });

// The household: a member with a connected, synced source; one who will change a password; one
// whose password the admin resets.
app.auth.createUser(E2E_USER, E2E_PASS);
app.auth.createUser(E2E_PW_USER, E2E_PW_PASS);
app.auth.createUser(E2E_RESET_USER, E2E_RESET_PASS);
app.account.setConsentAcceptedAt(E2E_USER, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
app.sources.add({
  userId: E2E_USER, display: 'Fake Regional Health', fhirBaseUrl: fakeBase, tokenUrl: `${fakeBase}/token`, clientId: 'fake-cid',
  patient: 'pa', resourceTypes: ['Condition', 'MedicationStatement'], accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999,
  platformType: 'ehr', environment: 'production', // a production source for the member's Explore page; the catalog seed stays a sandbox entry
});
await app.syncNow(1_000_000);
app.config.set('backup.destination', join(dir, 'backups'));

await new Promise<void>((resolve) => app.server.listen(E2E_PORT, '127.0.0.1', resolve));
console.log(`[e2e] spike listening on http://127.0.0.1:${E2E_PORT}; data in ${dir}; web ${webDir}`);

const stop = async (): Promise<void> => { fake.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
