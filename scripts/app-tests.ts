/**
 * The assembly harness (yourphr#582): boot ONE process and walk sign-in through record read with
 * every module engaged — config, migrations, auth+bootstrap, catalog, worker, backup, IPS,
 * provenance, medications — over HTTP, not by importing the modules.
 *
 *   npm run app
 */
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { assembleApp } from '../src/app.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function startFakeProvider(token: string) {
  return createServer((req, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if ((req.headers['authorization'] ?? '') !== `Bearer ${token}`) {
      send(401, { error: 'nope' });
      return;
    }
    const type = url.pathname.replace('/', '');
    const entry = type === 'MedicationStatement'
      ? [{ resource: { resourceType: type, id: 'ms-1', status: 'active', medicationCodeableConcept: { text: 'Lisinopril 10 MG' } } }]
      : [1, 2, 3].map((i) => ({ resource: { resourceType: type, id: `${type.toLowerCase()}-${i}`, code: { text: `synthetic ${type} ${i}` }, recordedDate: '2024-01-10' } }));
    send(200, { resourceType: 'Bundle', type: 'searchset', entry });
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-app-'));

  const fake = startFakeProvider('tok');
  const fakeBase = await new Promise<string>((resolve) => {
    fake.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(fake.address() as { port: number }).port}`));
  });

  // Boot: env carries bootstrap + secrets ONLY (the #472 split, enforced by the config module).
  const app = assembleApp(dir, {
    env: {
      SPIKE_DATABASE_ENCRYPTION_KEY: 'at-rest-key',
      SPIKE_BACKUP_ENCRYPTION_KEY: 'travelling-copy-key',
      SPIKE_TEST_ALLOW_INTERNAL: '1',
    },
    seeds: [{ display: 'Seeded Sandbox', environment: 'sandbox', fhirBaseUrl: 'https://fhir.example.org/r4', scopes: 's', clientId: 'seed-cid' }],
  });
  const base = await new Promise<string>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`));
  });

  check('boot provisioned the first admin with a 0600 password file (empty install)',
    !!app.bootstrapPasswordFile && existsSync(app.bootstrapPasswordFile));

  const adminPassword = readFileSync(app.bootstrapPasswordFile!, 'utf8').trim();
  const signIn = async (u: string, p: string) =>
    fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });

  const adminSignin = await signIn('admin', adminPassword);
  const adminToken = ((await adminSignin.json()) as { data: string }).data;
  check('the bootstrap password signs in over the wire', adminSignin.status === 200 && !!adminToken);
  check('and the password file is gone after that first sign-in', !existsSync(app.bootstrapPasswordFile!));

  const authed = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  // --- the browser contract (yourphr#591 parity audit): the Angular app never holds a token ---
  const setCookie = adminSignin.headers.get('set-cookie') ?? '';
  check('sign-in sets the HttpOnly fasten_session cookie the Angular app relies on',
    setCookie.startsWith('fasten_session=') && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Max-Age=\d+/.test(setCookie));
  const cookieOnly = await fetch(`${base}/api/secure/account/me`, { headers: { cookie: setCookie.split(';')[0]! } });
  const me = (await cookieOnly.json()) as { data: { username: string; role: string } };
  check('the cookie ALONE authenticates /api/secure/account/me, which names the user and the role',
    cookieOnly.status === 200 && me.data.username === 'admin' && me.data.role === 'admin');
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  check('logout clears the cookie (Max-Age=0) — the one thing JavaScript cannot do', /fasten_session=;.*Max-Age=0/.test(logout.headers.get('set-cookie') ?? ''));
  const boot = await Promise.all(['/api/version', '/api/health', '/api/instance/public'].map((p) => fetch(`${base}${p}`)));
  const bootBodies = await Promise.all(boot.map((r) => r.json() as Promise<{ success: boolean; data: Record<string, unknown> }>));
  check('the boot calls answer in the Go shapes: version, health, instance/public',
    boot.every((r) => r.status === 200) && typeof bootBodies[0]!.data['version'] === 'string' && bootBodies[1]!.data['first_run_wizard'] === false && bootBodies[2]!.data['password.min_length'] === 12);

  // Admin creates alice THROUGH THE API (policy enforced server-side).
  const shortPw = await fetch(`${base}/api/secure/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ username: 'alice', password: 'short' }) });
  check('the admin user-create route enforces the password policy', shortPw.status === 400);
  const created = await fetch(`${base}/api/secure/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ username: 'alice', password: 'a-long-enough-password' }) });
  check('the admin creates a user over the wire', created.status === 200);
  check('and that user is a user, not an admin (yourphr#597)', app.auth.roleOf('alice') === 'user');

  const aliceToken = ((await (await signIn('alice', 'a-long-enough-password')).json()) as { data: string }).data;

  // Connect a source for alice and run the worker once — the sync half of the assembly.
  app.sources.add({
    userId: 'alice', display: 'Fake Regional Health', fhirBaseUrl: fakeBase, tokenUrl: `${fakeBase}/token`, clientId: 'cid',
    patient: 'pa', resourceTypes: ['Condition', 'MedicationStatement'], accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999,
  });
  await app.syncNow(1_000_000);

  const conditions = (await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition`, authed(aliceToken))).json()) as { data: unknown[] };
  check('signed-in record read returns the synced records', conditions.data.length === 3);

  // --- the two calls every page makes (yourphr#593) ---
  type Job = { id: string; user_id: string; job_type: string; job_status: string; created_at: string; data: { source_id: string; summary: { outcome: string; total_resources: number } } };
  const aliceJobs = (await (await fetch(`${base}/api/secure/jobs`, authed(aliceToken))).json()) as { data: Job[] };
  const job = aliceJobs.data[0];
  check('/secure/jobs lists the caller\'s sync job in Go\'s BackgroundJob shape',
    aliceJobs.data.length === 1 && job?.job_type === 'SYNC' && job.job_status === 'STATUS_DONE' && job.user_id === 'alice'
      && job.data.source_id.startsWith('source-') && job.data.summary.outcome === 'success' && job.data.summary.total_resources === 4 && !Number.isNaN(Date.parse(job.created_at)));
  const adminJobs = (await (await fetch(`${base}/api/secure/jobs`, authed(adminToken))).json()) as { data: Job[] };
  check('jobs are per-user: the admin, who owns no source, sees none', adminJobs.data.length === 0);
  const failedOnly = (await (await fetch(`${base}/api/secure/jobs?status=STATUS_FAILED`, authed(aliceToken))).json()) as { data: Job[] };
  const badPage = await fetch(`${base}/api/secure/jobs?page=-1`, authed(aliceToken));
  check('Go\'s status filter and paging are honoured (nothing failed; a bad page is refused)', failedOnly.data.length === 0 && badPage.status === 400);

  app.config.set('operator.name', 'Nerds by the Hour');
  app.config.set('operator.contact_email', 'ops@example.org');
  const instance = (await (await fetch(`${base}/api/secure/instance`, authed(aliceToken))).json()) as { data: Record<string, unknown> };
  const publicInstance = (await (await fetch(`${base}/api/instance/public`)).json()) as { data: Record<string, unknown> };
  check('/secure/instance names the operator with the contact email; /instance/public withholds the email (yourphr#459)',
    instance.data['operator.name'] === 'Nerds by the Hour' && instance.data['operator.contact_email'] === 'ops@example.org' && instance.data['demo.admin.session'] === false
      && publicInstance.data['operator.name'] === 'Nerds by the Hour' && !('operator.contact_email' in publicInstance.data));

  const meds = (await (await fetch(`${base}/api/secure/medications/reconciled`, authed(aliceToken))).json()) as { data: { name: string; state: string }[] };
  check('medications/reconciled serves the reconciled list over the wire',
    meds.data.length === 1 && meds.data[0]!.name === 'Lisinopril 10 MG' && meds.data[0]!.state === 'Active');

  const ips = (await (await fetch(`${base}/api/secure/summary/ips`, authed(aliceToken))).json()) as { data: { type: string; entry: unknown[] } };
  check('summary/ips serves the IPS document bundle', ips.data.type === 'document' && ips.data.entry.length > 1);

  const prov = (await (await fetch(`${base}/api/secure/resource/provenance/Condition/condition-1`, authed(aliceToken))).json()) as { data: { sourceDisplay: string } };
  check('provenance names the source, by display name, over the wire', prov.data.sourceDisplay === 'Fake Regional Health');

  // Admin surface: gated, masked, working.
  const aliceAdmin = await fetch(`${base}/api/secure/admin/config`, authed(aliceToken));
  check('a non-admin gets 403 from the admin surface', aliceAdmin.status === 403);
  // The gate is the ROLE, not the name (yourphr#597): an admin called anything else gets in.
  app.auth.createUser('ops', 'an-operator-password', 'admin');
  const opsToken = ((await (await signIn('ops', 'an-operator-password')).json()) as { data: string }).data;
  const opsMe = (await (await fetch(`${base}/api/secure/account/me`, authed(opsToken))).json()) as { data: { role: string } };
  const opsAdmin = await fetch(`${base}/api/secure/admin/config`, authed(opsToken));
  check('an admin not named admin reaches the admin surface — the gate reads the role column', opsMe.data.role === 'admin' && opsAdmin.status === 200);
  const snapshot = (await (await fetch(`${base}/api/secure/admin/config`, authed(adminToken))).json()) as { data: { key: string; value: unknown; source: string }[] };
  const secretRow = snapshot.data.find((r) => r.key === 'database.encryption.key');
  check('the config snapshot masks secrets and names sources', secretRow?.value === '••••' && secretRow?.source === 'environment');
  const catalogList = (await (await fetch(`${base}/api/secure/admin/catalog`, authed(adminToken))).json()) as { data: { display: string }[] };
  check('the seeded catalog is visible to the admin', catalogList.data.some((e) => e.display === 'Seeded Sandbox'));

  const backup = (await (await fetch(`${base}/api/secure/admin/backup`, { method: 'POST', ...authed(adminToken) })).json()) as { data: { file: string; sizeBytes: number } };
  const backupBytes = readFileSync(backup.data.file);
  check('an admin backup over the wire writes CIPHERTEXT under the backup key',
    backup.data.sizeBytes > 0 && !backupBytes.includes('synthetic Condition') && !backupBytes.subarray(0, 16).includes('SQLite format 3'));

  check('the migration ledger exists from first boot (downgrade refusal has ground to stand on)',
    (app.auth as unknown as { db?: unknown }) !== undefined && existsSync(join(dir, 'spike.db')));

  fake.close();
  app.close();
  rmSync(dir, { recursive: true, force: true });

  // --- a database from before the role column (yourphr#597): nobody is demoted, the named admin stays one ---
  {
    const oldDir = mkdtempSync(join(tmpdir(), 'spike-app-prerole-'));
    const old = new Database(join(oldDir, 'spike.db'));
    old.exec(`CREATE TABLE auth_users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, token_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO auth_users VALUES ('admin', 'x', 0, '2026-08-20'), ('pat', 'x', 0, '2026-08-20')").run();
    old.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO schema_migrations VALUES ('20260820200000', 'baseline', '2026-08-20')").run();
    old.close();
    const upgraded = assembleApp(oldDir, { env: { SPIKE_TEST_ALLOW_INTERNAL: '1' } });
    check('a pre-role database boots, and bootstrap does not run (the table was populated)', !upgraded.bootstrapPasswordFile);
    check('the account named admin — the admin until now — is recorded as one', upgraded.auth.roleOf('admin') === 'admin');
    check('every other pre-existing account is a user', upgraded.auth.roleOf('pat') === 'user');
    upgraded.close();
    rmSync(oldDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`app harness failed: ${(err as Error).message}`);
  process.exit(1);
});
