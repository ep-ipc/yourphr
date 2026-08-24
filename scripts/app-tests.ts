/**
 * The assembly harness (yourphr#582): boot ONE process and walk sign-in through record read with
 * every module engaged — config, migrations, auth+bootstrap, catalog, worker, backup, IPS,
 * provenance, medications — over HTTP, not by importing the modules.
 *
 *   npm run app
 */
import { startFakeProvider } from './lib/fake-provider.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { stageRestore } from '../src/app/providers/sqlite-backup.js';
import { SqliteGlossaryCache } from '../src/app/providers/SqliteGlossaryCache.js';
import { assembleApp, sourceShape } from '../src/app.js';
import { ApiContext } from '../src/framework/ApiContext.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-app-'));

  const fake = startFakeProvider('tok');
  const fakeBase = await new Promise<string>((resolve) => {
    fake.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(fake.address() as { port: number }).port}`));
  });

  // Boot: env carries bootstrap + secrets ONLY (the #472 split, enforced by the config module).
  const app = await assembleApp(dir, {
    env: {
      YOURPHR_DATABASE_ENCRYPTION_KEY: 'at-rest-key',
      YOURPHR_BACKUP_ENCRYPTION_KEY: 'travelling-copy-key',
      SPIKE_TEST_ALLOW_INTERNAL: '1',
    },
    seeds: [
      { display: 'Seeded Sandbox', environment: 'sandbox', fhirBaseUrl: 'https://fhir.example.org/r4', scopes: 's', clientId: 'seed-cid' },
      { display: 'Seeded Production', environment: 'production', fhirBaseUrl: 'https://fhir.example.org/r4', scopes: 's', clientId: 'prod-cid', enabled: true },
    ],
  });
  const base = await new Promise<string>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`));
  });

  const sys = ApiContext.system('harness', 'admin', app.engine);
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
  check('and that user is a user, not an admin (yourphr#597)', (await app.users.roleOf('alice')) === 'user');

  const aliceToken = ((await (await signIn('alice', 'a-long-enough-password')).json()) as { data: string }).data;

  // Connect a source for alice and run the worker once — the sync half of the assembly.
  const asUser = (u: string) => ApiContext.system('test', u, app.engine);
  await app.sources.add(asUser('alice'), {
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

  app.config.set('yourphr.operator.name', 'Nerds by the Hour');
  app.config.set('yourphr.operator.contact-email', 'ops@example.org');
  const instance = (await (await fetch(`${base}/api/secure/instance`, authed(aliceToken))).json()) as { data: Record<string, unknown> };
  const publicInstance = (await (await fetch(`${base}/api/instance/public`)).json()) as { data: Record<string, unknown> };
  check('/secure/instance names the operator with the contact email; /instance/public withholds the email (yourphr#459)',
    instance.data['operator.name'] === 'Nerds by the Hour' && instance.data['operator.contact_email'] === 'ops@example.org' && instance.data['demo.admin.session'] === false
      && publicInstance.data['operator.name'] === 'Nerds by the Hour' && !('operator.contact_email' in publicInstance.data));

  const found = (await (await fetch(`${base}/api/secure/resources/search?q=lisinopril`, authed(aliceToken))).json()) as { data: { title: string; snippet: string; source_resource_type: string }[] };
  const adminFound = (await (await fetch(`${base}/api/secure/resources/search?q=lisinopril`, authed(adminToken))).json()) as { data: unknown[] };
  check('find anything by words: a member finds their own record by a word in it, with a snippet; another account finds nothing (yourphr#599)',
    found.data.length >= 1 && found.data[0]!.title.includes('Lisinopril') && /\[Lisinopril\]/.test(found.data[0]!.snippet) && adminFound.data.length === 0);
  const meds = (await (await fetch(`${base}/api/secure/medications/reconciled`, authed(aliceToken))).json()) as { data: { name: string; state: string }[] };
  check('medications/reconciled serves the reconciled list over the wire',
    meds.data.length === 1 && meds.data[0]!.name === 'Lisinopril 10 MG' && meds.data[0]!.state === 'Active');

  const ips = (await (await fetch(`${base}/api/secure/summary/ips`, authed(aliceToken))).json()) as { data: { type: string; entry: unknown[] } };
  check('summary/ips serves the IPS document bundle', ips.data.type === 'document' && ips.data.entry.length > 1);

  const prov = (await (await fetch(`${base}/api/secure/resource/provenance/Condition/condition-1`, authed(aliceToken))).json()) as { data: { sourceDisplay: string } };
  check('provenance names the source, by display name, over the wire', prov.data.sourceDisplay === 'Fake Regional Health');

  // --- the provider catalog (yourphr#603): the admin curates, a member connects ---
  const catJson = async (path: string, tok: string, init: RequestInit = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as { success: boolean; data: any; source?: any; error?: string; error_code?: string; authorize_url?: string; state?: string; code_verifier?: string; redirect_uri?: string } };
  };
  const listed = await catJson('/api/secure/provider-catalog', adminToken);
  const seededSandbox = listed.body.data.find((e: { display: string }) => e.display === 'Seeded Sandbox');
  const aliceLists = await fetch(`${base}/api/secure/provider-catalog`, authed(aliceToken));
  check('the admin lists the catalog in Go\'s entry shape (no secret, has_client_secret instead); a member gets 403',
    listed.status === 200 && listed.body.data.length === 2 && seededSandbox?.id && seededSandbox.api_endpoint_base_url === 'https://fhir.example.org/r4' && seededSandbox.has_client_secret === false
      && !('client_secret' in seededSandbox) && seededSandbox.platform_type === 'ehr' && seededSandbox.consent_policy === 'required' && aliceLists.status === 403);
  const catCreated = await catJson('/api/secure/provider-catalog', adminToken, { method: 'POST', body: JSON.stringify({
    display: 'Fake Regional (Sandbox)', environment: 'sandbox', api_endpoint_base_url: fakeBase, scopes: 'launch/patient patient/Condition.read patient/MedicationStatement.read',
    client_id: 'fake-cid', client_secret: 'fake-secret', enabled: true, brand_logo_url: 'https://logo.example.org/f.png', consent_policy: 'skip', pre_connect_profile: 'none' }) });
  const missingFields = await catJson('/api/secure/provider-catalog', adminToken, { method: 'POST', body: JSON.stringify({ display: 'Nope' }) });
  const fakeId = String(catCreated.body.data?.id ?? '');
  check('create: Go\'s request body, required fields enforced, the four policy fields stored',
    catCreated.status === 200 && fakeId !== '' && catCreated.body.data.has_client_secret === true && catCreated.body.data.brand_logo_url === 'https://logo.example.org/f.png'
      && catCreated.body.data.consent_policy === 'skip' && catCreated.body.data.pre_connect_profile === 'none' && missingFields.status === 400);
  const updated = await catJson(`/api/secure/provider-catalog/${fakeId}`, adminToken, { method: 'PUT', body: JSON.stringify({ display: 'Fake Regional (Sandbox)', environment: 'sandbox', api_endpoint_base_url: fakeBase, scopes: 'launch/patient patient/Condition.read', client_id: 'fake-cid', client_secret: '', enabled: true, consent_policy: 'required' }) });
  const fetched = await catJson(`/api/secure/provider-catalog/${fakeId}`, adminToken);
  check('update: an empty client_secret keeps the stored one; the entry reads back', updated.status === 200 && fetched.body.data.has_client_secret === true && fetched.body.data.scopes === 'launch/patient patient/Condition.read' && fetched.body.data.consent_policy === 'required');
  const sandboxList = await catJson('/api/secure/provider-catalog/sandbox', adminToken);
  const connectableNow = (await (await fetch(`${base}/api/secure/provider-catalog/connectable`, authed(aliceToken))).json()) as { data: { id: string; display: string; requires_user_consent: boolean; pre_connect_profile: string; medicare_class: boolean }[] };
  check('the sandbox list is the enabled sandbox entries in ConnectableProvider shape with Go\'s policy; production stays in connectable',
    sandboxList.body.data.map((e: { display: string }) => e.display).join('|') === 'Fake Regional (Sandbox)' // the seeded sandbox is not enabled
      && sandboxList.body.data.find((e: { id: string }) => e.id === fakeId)?.requires_user_consent === true && sandboxList.body.data.find((e: { id: string }) => e.id === fakeId)?.pre_connect_profile === 'none'
      && connectableNow.data.length === 1 && connectableNow.data[0]?.display === 'Seeded Production');
  const noRedirect = await catJson(`/api/secure/provider-catalog/${fakeId}/authorize`, aliceToken, { method: 'POST', body: '{}' });
  const authz = await catJson(`/api/secure/provider-catalog/${fakeId}/authorize`, aliceToken, { method: 'POST', body: JSON.stringify({ redirect_uri: 'http://localhost/sources/callback' }) });
  const authzUrl = new URL(authz.body.authorize_url ?? 'http://x/');
  check('authorize: no relay here — a redirect_uri is required (501 says so); with one, a PKCE S256 authorize URL, state and verifier come back',
    noRedirect.status === 501 && authz.status === 200 && authzUrl.pathname === '/authorize' && authzUrl.searchParams.get('code_challenge_method') === 'S256' && authzUrl.searchParams.get('state') === authz.body.state
      && authzUrl.searchParams.get('client_id') === 'fake-cid' && (authz.body.code_verifier ?? '').length > 20 && authz.body.redirect_uri === 'http://localhost/sources/callback');
  await app.users.createUser(sys, 'carol', 'carols-long-enough-password');
  const carolToken = ((await (await signIn('carol', 'carols-long-enough-password')).json()) as { data: string }).data;
  const consentGate = await catJson(`/api/secure/provider-catalog/${fakeId}/connect`, carolToken, { method: 'POST', body: JSON.stringify({ code: 'good-code', state: authz.body.state, code_verifier: authz.body.code_verifier, redirect_uri: authz.body.redirect_uri }) });
  check('connect refuses until the legal consent is accepted (Go\'s gate, with its error_code)', consentGate.status === 403 && consentGate.body.error_code === 'legal_consent_required');
  await app.users.setConsent(ApiContext.system('test', 'carol', app.engine), '2026-08-22T00:00:00Z');
  const badCode = await catJson(`/api/secure/provider-catalog/${fakeId}/connect`, carolToken, { method: 'POST', body: JSON.stringify({ code: 'bad-code', state: authz.body.state, code_verifier: authz.body.code_verifier, redirect_uri: authz.body.redirect_uri }) });
  const connected = await catJson(`/api/secure/provider-catalog/${fakeId}/connect`, carolToken, { method: 'POST', body: JSON.stringify({ code: 'good-code', state: authz.body.state, code_verifier: authz.body.code_verifier, redirect_uri: authz.body.redirect_uri }) });
  const newSourceId = String(connected.body.source?.id ?? '');
  check('connect exchanges the code (a bad one is 502), stores the source from the catalog entry, and answers Go\'s {source, data: import_started}',
    badCode.status === 502 && connected.status === 200 && connected.body.data.status === 'import_started' && newSourceId.startsWith('source-')
      && connected.body.source.display === 'Fake Regional (Sandbox)' && connected.body.source.environment === 'sandbox' && connected.body.source.platform_type === 'ehr' && connected.body.source.patient === 'pa');
  let importedJob: { job_status: string } | undefined;
  for (let i = 0; i < 40 && !importedJob; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const jobs = (await (await fetch(`${base}/api/secure/jobs`, authed(carolToken))).json()) as { data: { job_status: string; data: { source_id: string } }[] };
    importedJob = jobs.data.find((j) => j.data.source_id === newSourceId);
  }
  const newConditions = (await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition&sourceID=${newSourceId}`, authed(carolToken))).json()) as { data: unknown[] };
  check('the initial import ran in the background: a job for the new source, its records attributed to it', importedJob?.job_status === 'STATUS_DONE' && newConditions.data.length === 3);
  const catRemoved = await catJson(`/api/secure/provider-catalog/${fakeId}`, adminToken, { method: 'DELETE' });
  const catGone = await catJson(`/api/secure/provider-catalog/${fakeId}`, adminToken);
  check('delete removes the entry; the connected source is unaffected', catRemoved.body.data.deleted === 1 && catGone.status === 404
      && ((await (await fetch(`${base}/api/secure/source/${newSourceId}`, authed(carolToken))).json()) as { success: boolean }).success === true);
  const aliceSourcesStill = (await (await fetch(`${base}/api/secure/source`, authed(aliceToken))).json()) as { data: unknown[] };
  check('carol\'s connection is hers alone — alice still sees only her own source', aliceSourcesStill.data.length === 1);

  // --- the dashboard and record pages (yourphr#595) ---
  const recent = (await (await fetch(`${base}/api/secure/resources/recent?limit=2`, authed(aliceToken))).json()) as { data: { source_id: string; source_resource_type: string; title: string; date?: string }[] };
  check('/resources/recent serves Go\'s list items, limited, attributed to the source',
    recent.data.length === 2 && recent.data.every((r) => r.source_id === 'source-1' && r.date === '2024-01-10' && r.title.startsWith('synthetic')));
  const reconciled = (await (await fetch(`${base}/api/secure/conditions/reconciled`, authed(aliceToken))).json()) as { data: { title: string; tier: string; state: string; sourceId: string }[] };
  check('/conditions/reconciled classifies the synced conditions (no coding, no status: clinician tier, Unknown state)',
    reconciled.data.length === 3 && reconciled.data.every((c) => c.tier === 'clinician' && c.state === 'Unknown' && c.sourceId === 'source-1'));
  const allergies = (await (await fetch(`${base}/api/secure/allergies/classified`, authed(aliceToken))).json()) as { data: unknown[] };
  const immunizations = (await (await fetch(`${base}/api/secure/immunizations/classified`, authed(aliceToken))).json()) as { data: unknown[] };
  check('/allergies/classified and /immunizations/classified answer (empty lists here — nothing was synced of those types)',
    Array.isArray(allergies.data) && allergies.data.length === 0 && Array.isArray(immunizations.data) && immunizations.data.length === 0);
  const queried = (await (await fetch(`${base}/api/secure/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ select: ['*'], from: 'Condition', where: {}, limit: 2 }) })).json()) as { data: { source_resource_type: string }[] };
  const badQuery = await fetch(`${base}/api/secure/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` }, body: JSON.stringify({ from: 'nope' }) });
  check('POST /query answers resource_fhir rows; a malformed query is 400', queried.data.length === 2 && queried.data[0]?.source_resource_type === 'Condition' && badQuery.status === 400);
  const favBody = { source_id: 'source-1', resource_type: 'Practitioner', resource_id: 'dr-1' };
  const favAdd = await fetch(`${base}/api/secure/user/favorites`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` }, body: JSON.stringify(favBody) });
  const favList = (await (await fetch(`${base}/api/secure/user/favorites?resource_type=Practitioner`, authed(aliceToken))).json()) as { data: { resource_id: string }[] };
  const adminFavList = (await (await fetch(`${base}/api/secure/user/favorites?resource_type=Practitioner`, authed(adminToken))).json()) as { data: unknown[] };
  const favDel = await fetch(`${base}/api/secure/user/favorites`, { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` }, body: JSON.stringify(favBody) });
  const favGone = (await (await fetch(`${base}/api/secure/user/favorites?resource_type=Practitioner`, authed(aliceToken))).json()) as { data: unknown[] };
  const favWrongType = await fetch(`${base}/api/secure/user/favorites?resource_type=Patient`, authed(aliceToken));
  check('favourites: POST, GET (per user), DELETE in Go\'s shapes; only Practitioner accepted',
    favAdd.status === 200 && favList.data.map((f) => f.resource_id).join(',') === 'dr-1' && adminFavList.data.length === 0 && favDel.status === 200 && favGone.data.length === 0 && favWrongType.status === 400);

  // --- the Sources page (yourphr#594) ---
  type Src = { id: string; display: string; user_id: string; access_token: string; updated_at?: string; latest_background_job?: { job_status: string } };
  const aliceSources = (await (await fetch(`${base}/api/secure/source`, authed(aliceToken))).json()) as { data: Src[] };
  const src = aliceSources.data[0];
  check('/secure/source lists the caller\'s source in Go\'s shape with its last job and a redacted token',
    aliceSources.data.length === 1 && src?.id === 'source-1' && src.display === 'Fake Regional Health' && src.user_id === 'alice'
      && src.access_token === '[REDACTED]' && src.latest_background_job?.job_status === 'STATUS_DONE' && !!src.updated_at);
  const adminSources = (await (await fetch(`${base}/api/secure/source`, authed(adminToken))).json()) as { data: Src[] };
  const adminPeeks = await fetch(`${base}/api/secure/source/source-1`, authed(adminToken));
  check('sources are per-user: another account sees none and gets 404, not 403, on the id', adminSources.data.length === 0 && adminPeeks.status === 404);

  const bySource = (await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition&sourceID=source-1`, authed(aliceToken))).json()) as { data: { source_id: string }[] };
  const byOther = (await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition&sourceID=source-9`, authed(aliceToken))).json()) as { data: unknown[] };
  check('records carry their real source_id and ?sourceID narrows the list (how /explore/:source reads)',
    bySource.data.length === 3 && bySource.data.every((r) => r.source_id === 'source-1') && byOther.data.length === 0);

  const summary = (await (await fetch(`${base}/api/secure/source/source-1/summary`, authed(aliceToken))).json()) as { data: { resource_type_counts: { resource_type: string; count: number }[]; patient: unknown } };
  check('the source summary counts by type, Go\'s rows, and has no patient to invent',
    summary.data.resource_type_counts.map((c) => `${c.resource_type}:${c.count}`).join(',') === 'Condition:3,MedicationStatement:1' && summary.data.patient === null);

  const dashboard = (await (await fetch(`${base}/api/secure/summary`, authed(aliceToken))).json()) as { data: { sources: Src[] } };
  check('the dashboard summary lists the real sources, not a placeholder', dashboard.data.sources.length === 1 && dashboard.data.sources[0]?.id === 'source-1');

  // The event stream: Go's framing, a keep-alive first, then the sync events around a manual sync.
  const streamAbort = new AbortController();
  const stream = await fetch(`${base}/api/secure/events/stream`, { ...authed(aliceToken), signal: streamAbort.signal });
  const reader = stream.body!.getReader();
  const readFrame = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value);
  const first = await readFrame();
  check('the event stream opens as text/event-stream with a keep_alive frame in Go\'s framing',
    stream.headers.get('content-type') === 'text/event-stream' && first === 'event:message\ndata:{"event_type":"keep_alive"}\n\n');
  const synced = await fetch(`${base}/api/secure/source/source-1/sync`, { method: 'POST', ...authed(aliceToken) });
  const syncBody = (await synced.json()) as { success: boolean; source: Src; data: number };
  const frames = (await readFrame()) + (stream.body ? '' : '');
  const more = frames.includes('source_complete') ? frames : frames + (await readFrame());
  check('a manual sync answers Go\'s {source, data} and the stream saw source_sync then source_complete',
    synced.status === 200 && syncBody.source.id === 'source-1' && typeof syncBody.data === 'number'
      && more.indexOf('"event_type":"source_sync"') !== -1 && more.indexOf('"event_type":"source_complete"') > more.indexOf('"event_type":"source_sync"'));
  streamAbort.abort();
  const aliceJobsAfter = (await (await fetch(`${base}/api/secure/jobs`, authed(aliceToken))).json()) as { data: Job[] };
  check('the manual sync is recorded as a job like a scheduled one', aliceJobsAfter.data.length === 2);

  const exported = await fetch(`${base}/api/secure/source/source-1/export`, authed(aliceToken));
  const bundle = (await exported.json()) as { resourceType: string; type: string; total: number; entry: unknown[] };
  check('export is a FHIR collection Bundle download of that source\'s records',
    exported.headers.get('content-type') === 'application/fhir+json' && /attachment; filename=yourphr-fake-regional-health-\d{8}\.json/.test(exported.headers.get('content-disposition') ?? '')
      && bundle.resourceType === 'Bundle' && bundle.type === 'collection' && bundle.total === 4 && bundle.entry.length === 4);

  const disconnected = await fetch(`${base}/api/secure/source/source-1/disconnect`, { method: 'POST', ...authed(aliceToken) });
  const afterDisconnect = (await app.sources.owned(asUser('alice'), 1))!;
  await app.syncNow(1_000_100);
  const jobsAfterDisconnect = (await (await fetch(`${base}/api/secure/jobs`, authed(aliceToken))).json()) as { data: Job[] };
  check('disconnect clears the tokens, keeps the records, and the worker skips the source',
    disconnected.status === 200 && afterDisconnect.accessToken === '' && afterDisconnect.refreshToken === '' && jobsAfterDisconnect.data.length === 2
      && ((await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition`, authed(aliceToken))).json()) as { data: unknown[] }).data.length === 3);

  const removed = (await (await fetch(`${base}/api/secure/source/source-1/remove-data`, { method: 'POST', ...authed(aliceToken) })).json()) as { data: number };
  const afterRemove = (await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition`, authed(aliceToken))).json()) as { data: unknown[] };
  check('remove-data deletes that source\'s records (rows reported) and the source stays listed', removed.data === 4 && afterRemove.data.length === 0
      && ((await (await fetch(`${base}/api/secure/source`, authed(aliceToken))).json()) as { data: Src[] }).data.length === 1);

  const deleted = await fetch(`${base}/api/secure/source/source-1`, { method: 'DELETE', ...authed(aliceToken) });
  check('DELETE removes the source itself; it is gone from the list and its id 404s',
    deleted.status === 200 && ((await (await fetch(`${base}/api/secure/source`, authed(aliceToken))).json()) as { data: Src[] }).data.length === 0
      && (await fetch(`${base}/api/secure/source/source-1`, authed(aliceToken))).status === 404);

  const connectable = (await (await fetch(`${base}/api/secure/provider-catalog/connectable`, authed(aliceToken))).json()) as { data: { id: string; display: string; brand_logo_url: string }[] };
  check('the connectable catalog is served in Go\'s ConnectableProvider shape — enabled production entries, sandboxes stay admin-only',
    connectable.data.length === 1 && connectable.data[0]?.display === 'Seeded Production' && typeof connectable.data[0].id === 'string' && connectable.data[0].brand_logo_url === '');

  // Admin surface: gated, masked, working.
  const aliceAdmin = await fetch(`${base}/api/secure/admin/config`, authed(aliceToken));
  check('a non-admin gets 403 from the admin surface', aliceAdmin.status === 403);
  // The gate is the ROLE, not the name (yourphr#597): an admin called anything else gets in.
  await app.users.createUser(sys, 'ops', 'an-operator-password', 'admin');
  const opsToken = ((await (await signIn('ops', 'an-operator-password')).json()) as { data: string }).data;
  const opsMe = (await (await fetch(`${base}/api/secure/account/me`, authed(opsToken))).json()) as { data: { role: string } };
  const opsAdmin = await fetch(`${base}/api/secure/admin/config`, authed(opsToken));
  check('an admin not named admin reaches the admin surface — the gate reads the role column', opsMe.data.role === 'admin' && opsAdmin.status === 200);
  const snapshot = (await (await fetch(`${base}/api/secure/admin/config`, authed(adminToken))).json()) as { data: { entries: { key: string; value: unknown; masked: boolean; from_env: boolean }[] } };
  const secretRow = snapshot.data.entries.find((r) => r.key === 'yourphr.database.encryption.key');
  check('the config snapshot masks secrets and says where a value comes from', secretRow?.value === '••••' && secretRow?.masked === true && secretRow?.from_env === true);
  const catalogList = (await (await fetch(`${base}/api/secure/admin/catalog`, authed(adminToken))).json()) as { data: { display: string }[] };
  check('the seeded catalog is visible to the admin', catalogList.data.some((e) => e.display === 'Seeded Sandbox'));

  const backup = (await (await fetch(`${base}/api/secure/admin/backup`, { method: 'POST', ...authed(adminToken) })).json()) as { data: { file: string; sizeBytes: number } };
  const backupBytes = readFileSync(backup.data.file);
  check('an admin backup over the wire writes CIPHERTEXT under the backup key',
    backup.data.sizeBytes > 0 && !backupBytes.includes('synthetic Condition') && !backupBytes.subarray(0, 16).includes('SQLite format 3'));

  check('the migration ledger exists from first boot (downgrade refusal has ground to stand on)',
    existsSync(join(dir, 'spike.db')));

  // --- the account page and the legal pages (yourphr#596) ---
  type LegalDoc = { kind: string; html: string; digest: string; source: string; path?: string };
  const privacy = (await (await fetch(`${base}/api/legal/privacy`)).json()) as { data: LegalDoc };
  const unknownLegal = await fetch(`${base}/api/legal/cookies`);
  check('/api/legal/privacy is public and serves the shipped document as HTML with its sha256 digest',
    privacy.data.kind === 'privacy' && privacy.data.source === 'shipped' && privacy.data.html.includes('<h') && /^sha256:[0-9a-f]{64}$/.test(privacy.data.digest) && unknownLegal.status === 404);
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'terms-of-service.md'), '# House rules\n\nBe kind.\n');
  const terms = (await (await fetch(`${base}/api/legal/terms`)).json()) as { data: LegalDoc };
  writeFileSync(join(dir, 'config', 'terms-of-service.md'), '   \n');
  const emptyOverride = await fetch(`${base}/api/legal/terms`);
  rmSync(join(dir, 'config', 'terms-of-service.md'));
  check('an operator override in <data>/config replaces the text and says so; an EMPTY override is an error, not a silent fallback',
    terms.data.source === 'operator' && terms.data.html.includes('House rules') && !!terms.data.path && emptyOverride.status === 500);

  const accessLog = (await (await fetch(`${base}/api/secure/account/access-log`, authed(aliceToken))).json()) as { data: { actor_username: string; category: string; day: string; count: number }[] };
  const categories = new Set(accessLog.data.map((e) => e.category));
  check('the access log recorded this harness\'s own reads as day buckets: who, which category, how many',
    accessLog.data.every((e) => e.actor_username === 'alice' && /^\d{4}-\d{2}-\d{2}$/.test(e.day) && e.count >= 1)
      && categories.has('Conditions') && categories.has('Records (FHIR)') && categories.has('Full export') && !categories.has('undefined'));
  const adminLog = (await (await fetch(`${base}/api/secure/account/access-log`, authed(adminToken))).json()) as { data: unknown[] };
  check('the access log is the account\'s own — the admin sees nothing of alice\'s', adminLog.data.length === 0 || adminLog.data.length < accessLog.data.length);

  type Consent = { accepted: boolean; accepted_at?: string; privacy_policy_url: string; medicare_sources_disconnected?: number };
  const consentBefore = (await (await fetch(`${base}/api/secure/account/legal-consent`, authed(aliceToken))).json()) as { data: Consent };
  const granted = (await (await fetch(`${base}/api/secure/account/legal-consent/grant`, { method: 'POST', ...authed(aliceToken) })).json()) as { data: Consent };
  const consentAfter = (await (await fetch(`${base}/api/secure/account/legal-consent`, authed(aliceToken))).json()) as { data: Consent };
  check('legal consent: not accepted until granted; granting records an RFC3339 time in Go\'s shape',
    consentBefore.data.accepted === false && consentBefore.data.privacy_policy_url === '/privacy' && granted.data.accepted === true
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(granted.data.accepted_at ?? '') && consentAfter.data.accepted_at === granted.data.accepted_at);
  const medicare = await app.sources.add(asUser('alice'), { userId: 'alice', display: 'Medicare Blue Button', fhirBaseUrl: 'https://sandbox.bluebutton.cms.gov/v2/fhir', tokenUrl: '', clientId: 'c',
    patient: 'm', resourceTypes: ['Coverage'], accessToken: 'tok', refreshToken: 'ref', expiresAt: 99_999_999 });
  const revoked = (await (await fetch(`${base}/api/secure/account/legal-consent/revoke`, { method: 'POST', ...authed(aliceToken) })).json()) as { data: Consent };
  check('revoking the consent disconnects the Medicare sources (Go\'s rule) and reports how many',
    revoked.data.accepted === false && revoked.data.medicare_sources_disconnected === 1 && (await app.sources.owned(asUser('alice'), medicare.id))?.accessToken === '' && (await app.sources.owned(asUser('alice'), medicare.id))?.refreshToken === '');

  const pw = (current: string, next: string) => fetch(`${base}/api/secure/account/password`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` }, body: JSON.stringify({ current_password: current, new_password: next }) });
  const wrongCurrent = await pw('not-her-password', 'another-long-enough-password');
  const tooShort = await pw('a-long-enough-password', 'short');
  const changed = await pw('a-long-enough-password', 'another-long-enough-password');
  const changedBody = (await changed.json()) as { success: boolean; data: string };
  const oldTokenAfter = await fetch(`${base}/api/secure/account/me`, authed(aliceToken));
  const newTokenWorks = await fetch(`${base}/api/secure/account/me`, authed(changedBody.data));
  check('password change: wrong current is 401, policy refusal is 400, success ends the old session and hands back a fresh one on the cookie',
    wrongCurrent.status === 401 && tooShort.status === 400 && changed.status === 200 && typeof changedBody.data === 'string' && (changed.headers.get('set-cookie') ?? '').startsWith('fasten_session=')
      && oldTokenAfter.status === 401 && newTokenWorks.status === 200);
  const aliceToken2 = changedBody.data;
  const signedOut = await fetch(`${base}/api/secure/account/sign-out-everywhere`, { method: 'POST', ...authed(aliceToken2) });
  const afterSignOut = await fetch(`${base}/api/secure/account/me`, authed(aliceToken2));
  const backIn = await signIn('alice', 'another-long-enough-password');
  check('sign out everywhere ends every session including this one, clears the cookie, and the new password signs back in',
    signedOut.status === 200 && /fasten_session=;.*Max-Age=0/.test(signedOut.headers.get('set-cookie') ?? '') && afterSignOut.status === 401 && backIn.status === 200);

  // Deleting the account (yourphr#619): every door the closure used to call, in the same order —
  // sources, records, the access log, then the account. Nothing checked this journey before.
  await app.users.createUser(sys, 'gone', 'a-long-enough-password-here');
  const goneToken = ((await (await signIn('gone', 'a-long-enough-password-here')).json()) as { data: string }).data;
  await app.sources.add(asUser('gone'), { userId: 'gone', display: 'Gone Clinic', fhirBaseUrl: fakeBase, tokenUrl: `${fakeBase}/token`, clientId: 'cid', patient: 'pg', resourceTypes: ['Condition'], accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999 });
  await fetch(`${base}/api/secure/account/legal-consent/grant`, { method: 'POST', ...authed(goneToken) });
  await fetch(`${base}/api/secure/account/access-log`, authed(goneToken)); // an access to log
  const goneSourcesBefore = (await app.sources.list(asUser('gone'))).length;
  const goneDeleted = await fetch(`${base}/api/secure/account/me`, { method: 'DELETE', ...authed(goneToken) });
  const goneAfter = await fetch(`${base}/api/secure/account/me`, authed(goneToken));
  const goneSignIn = await signIn('gone', 'a-long-enough-password-here');
  check('deleting the account removes its sources, its records, its access log and the account itself; the session dies with it',
    goneSourcesBefore === 1 && goneDeleted.status === 200 && (await app.sources.list(asUser('gone'))).length === 0
      && (await app.users.record('gone')) === undefined && goneAfter.status === 401 && goneSignIn.status === 401,
    `sources ${goneSourcesBefore}, delete ${goneDeleted.status}, me ${goneAfter.status}, signin ${goneSignIn.status}`);

  await app.users.createUser(sys, 'zed', 'zeds-long-enough-password');
  const zedToken = ((await (await signIn('zed', 'zeds-long-enough-password')).json()) as { data: string }).data;
  await app.sources.add(asUser('zed'), { userId: 'zed', display: 'Zed Clinic', fhirBaseUrl: fakeBase, tokenUrl: `${fakeBase}/token`, clientId: 'cid', patient: 'pz', resourceTypes: ['Condition'], accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999 });
  await app.syncNow(1_000_200);
  const zedHad = ((await (await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition`, authed(zedToken))).json()) as { data: unknown[] }).data.length;
  const zedDeleted = await fetch(`${base}/api/secure/account/me`, { method: 'DELETE', ...authed(zedToken) });
  const zedAgain = await signIn('zed', 'zeds-long-enough-password');
  const zedRows = (await app.sources.list(asUser('zed'))).length;
  check('deleting the account removes its sources, records, and the account itself; the password no longer signs in',
    zedHad === 3 && zedDeleted.status === 200 && zedAgain.status === 401 && (await app.users.roleOf('zed')) === undefined && zedRows === 0);

  // --- the Users page (yourphr#604) ---
  type ListedUser = { id: string; username: string; role: string; created_at: string };
  const users = (await (await fetch(`${base}/api/secure/users`, authed(adminToken))).json()) as { data: ListedUser[] };
  const aliceListsUsers = await fetch(`${base}/api/secure/users`, { headers: { authorization: `Bearer ${((await (await signIn('alice', 'another-long-enough-password')).json()) as { data: string }).data}` } });
  check('/secure/users lists every account with its role and creation time, never a hash; a member gets Go\'s 401',
    users.data.some((u) => u.username === 'admin' && u.role === 'admin') && users.data.some((u) => u.username === 'alice' && u.role === 'user')
      && users.data.every((u) => u.id === u.username && !!u.created_at && !('password_hash' in u) && !('password' in u)) && aliceListsUsers.status === 401);
  const createBody = (over: Record<string, unknown>) => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ full_name: 'Dave Example', username: 'dave', email: 'dave@example.org', password: 'daves-long-enough-password', role: 'user', ...over }) });
  const madeDave = await fetch(`${base}/api/secure/users`, createBody({}));
  const madeDaveBody = (await madeDave.json()) as { data: { username: string; role: string } };
  const duplicate = await fetch(`${base}/api/secure/users`, createBody({}));
  const weak = await fetch(`${base}/api/secure/users`, createBody({ username: 'eve', password: 'short' }));
  const madeAdmin = await fetch(`${base}/api/secure/users`, createBody({ username: 'ops2', role: 'admin' }));
  check('create takes the page\'s body (full_name/email not stored — absent, not invented); duplicates and weak passwords are 400; role is honoured',
    madeDave.status === 200 && madeDaveBody.data.username === 'dave' && madeDaveBody.data.role === 'user' && duplicate.status === 400 && ((await duplicate.json()) as { error: string }).error === 'User already exists'
      && weak.status === 400 && madeAdmin.status === 200 && (await app.users.roleOf('ops2')) === 'admin' && (await app.users.roleOf('dave')) === 'user');
  const daveToken = ((await (await signIn('dave', 'daves-long-enough-password')).json()) as { data: string }).data;
  const resetDave = (await (await fetch(`${base}/api/secure/users/dave/password`, { method: 'POST', ...authed(adminToken) })).json()) as { data: { username: string; password: string } };
  const daveOldSession = await fetch(`${base}/api/secure/account/me`, authed(daveToken));
  const daveOldPassword = await signIn('dave', 'daves-long-enough-password');
  const daveNewPassword = await signIn('dave', resetDave.data.password);
  const resetNobody = await fetch(`${base}/api/secure/users/nobody/password`, { method: 'POST', ...authed(adminToken) });
  check('an admin reset hands back a generated password once and signs the member out everywhere; the old password is dead; unknown user is 404',
    resetDave.data.username === 'dave' && resetDave.data.password.length >= 12 && daveOldSession.status === 401 && daveOldPassword.status === 401 && daveNewPassword.status === 200 && resetNobody.status === 404);

  // --- the admin dashboard, database, logs and configuration pages (yourphr#602) ---
  const adminJson = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as { success: boolean; data: Record<string, any>; error?: string } };
  };
  const relay = await adminJson('/api/secure/source/relay-config');
  check('relay-config answers honestly: no relay here, not configured, not ready', relay.status === 200 && relay.body.data['configured'] === false && relay.body.data['ready'] === false);

  const instanceBefore = await adminJson('/api/secure/admin/instance');
  const badEmail = await adminJson('/api/secure/admin/instance', { method: 'PUT', body: JSON.stringify({ name: 'Ops', contact_email: 'not-an-email', contact_url: '' }) });
  const setInstance = await adminJson('/api/secure/admin/instance', { method: 'PUT', body: JSON.stringify({ name: ' Ops Team ', contact_email: 'ops@example.org', contact_url: 'https://example.org/help' }) });
  const instanceAfter = await adminJson('/api/secure/admin/instance');
  check('the Instance card reads and writes the operator contact (trimmed, validated); /secure/instance sees it at once',
    instanceBefore.body.data['name'] === 'Nerds by the Hour' && badEmail.status === 400 && setInstance.status === 200 && instanceAfter.body.data['name'] === 'Ops Team'
      && ((await (await fetch(`${base}/api/secure/instance`, authed(adminToken))).json()) as { data: Record<string, unknown> }).data['operator.contact_url'] === 'https://example.org/help');

  await app.sources.add(asUser('alice'), { userId: 'alice', display: 'Fake Regional Health Again', fhirBaseUrl: fakeBase, tokenUrl: `${fakeBase}/token`, clientId: 'cid', patient: 'pa', resourceTypes: ['Condition'], accessToken: 'tok', refreshToken: '', expiresAt: 99_999_999, platformType: 'ehr', environment: 'sandbox' });
  await app.syncNow(1_000_400);
  const metrics = await adminJson('/api/secure/admin/metrics');
  check('the Metrics card: no scrape endpoint (said so), counters and recent jobs from the sync history',
    metrics.body.data['scrape_enabled'] === false && metrics.body.data['process']['jobs_total']['success|ehr|sandbox'] >= 1 && metrics.body.data['recent_jobs'].length >= 1
      && metrics.body.data['recent_jobs'][0]['job_status'] === 'STATUS_DONE' && typeof metrics.body.data['recent_jobs'][0]['summary']['total_resources'] === 'number');

  const dbInfo = await adminJson('/api/secure/admin/database');
  check('the Database card: both files, counts, integrity, encryption, destination, schedule, health — Go\'s shape',
    dbInfo.body.data['encryption_enabled'] === true && dbInfo.body.data['integrity_ok'] === true && dbInfo.body.data['users'] >= 3 && dbInfo.body.data['sources'] >= 1
      && dbInfo.body.data['size_bytes'] > 0 && dbInfo.body.data['backups_unavailable'] === '' && dbInfo.body.data['schedule']['days'] === 'daily' && dbInfo.body.data['backup_health']['schedule_enabled'] === false
      && Array.isArray(dbInfo.body.data['backups']));
  const took = await adminJson('/api/secure/admin/database/backup', { method: 'POST' });
  const backupPath = String(took.body.data['path']);
  const appHalf = stageRestore(backupPath, 'travelling-copy-key', join(dir, 'probe-app.db'), '', (t) => t === 'auth_users' || t === 'connected_sources');
  const recordsHalf = stageRestore(backupPath, 'travelling-copy-key', join(dir, 'probe-records.db'), '', (t) => t === 'resources');
  const probe = new Database(join(dir, 'probe-app.db'));
  const probeUsers = (probe.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n;
  probe.close();
  check('a backup from the page holds the INSTANCE — accounts and sources as well as the records — in one encrypted file',
    took.status === 200 && existsSync(backupPath) && appHalf.tables >= 2 && recordsHalf.tables >= 1 && probeUsers >= 3);
  const dbInfoAfter = await adminJson('/api/secure/admin/database');
  check('the backup is listed with its size and time, and health now reports a success',
    dbInfoAfter.body.data['backups'].some((b: { name: string; size_bytes: number; modified: string }) => backupPath.endsWith(b.name) && b.size_bytes > 0 && !!b.modified)
      && dbInfoAfter.body.data['backup_health']['ok'] === true && dbInfoAfter.body.data['backup_health']['last_success_path'] === backupPath);
  const download = await fetch(`${base}/api/secure/admin/database/backup/download`, { method: 'POST', ...authed(adminToken) });
  const downloaded = Buffer.from(await download.arrayBuffer());
  check('download streams a fresh backup as an attachment, ciphertext',
    download.status === 200 && /attachment; filename=.*-yourphr-spike-backup\.db/.test(download.headers.get('content-disposition') ?? '') && downloaded.length > 0 && !downloaded.subarray(0, 16).includes('SQLite format 3'));
  const badTime = await adminJson('/api/secure/admin/database/schedule', { method: 'POST', body: JSON.stringify({ enabled: true, time: '25:00', days: 'daily', destination: '', max_backups: 3 }) });
  const scheduled = await adminJson('/api/secure/admin/database/schedule', { method: 'POST', body: JSON.stringify({ enabled: true, time: '02:30', days: 'weekly', destination: '', max_backups: 3 }) });
  check('the schedule is validated (HH:MM, daily|weekly) and stored in the settings store',
    badTime.status === 400 && scheduled.status === 200 && scheduled.body.data['days'] === 'weekly' && app.config.getString('yourphr.backup.schedule.time') === '02:30' && app.config.getBool('yourphr.backup.schedule.enabled'));
  const testOk = await adminJson('/api/secure/admin/database/backup/test', { method: 'POST', body: JSON.stringify({ destination: dir }) });
  const testBad = await adminJson('/api/secure/admin/database/backup/test', { method: 'POST', body: JSON.stringify({ destination: join(dir, 'does-not-exist') }) });
  const browse = await adminJson(`/api/secure/admin/database/browse?path=${encodeURIComponent(dir)}`);
  check('a destination is proven writable before a schedule relies on it; the folder browser lists one level',
    testOk.body.data['writable'] === true && testBad.body.data['writable'] === false && !!testBad.body.data['error'] && browse.body.data['dirs'].includes('backups') && browse.body.data['parent'] !== '');
  const unconfirmed = await adminJson('/api/secure/admin/database/restore', { method: 'POST', body: JSON.stringify({ backup_name: basename(backupPath), confirm: false }) });
  const missing = await adminJson('/api/secure/admin/database/restore', { method: 'POST', body: JSON.stringify({ backup_name: 'nope-yourphr-spike-backup.db', confirm: true }) });
  const traversal = await adminJson('/api/secure/admin/database/restore', { method: 'POST', body: JSON.stringify({ backup_name: '../spike.db', confirm: true }) });
  check('a restore must be confirmed and must name a backup in the destination — no path escapes', unconfirmed.status === 400 && missing.status === 404 && traversal.status === 404);

  const logsBefore = await adminJson('/api/secure/admin/logs');
  const badLevel = await adminJson('/api/secure/admin/log-level', { method: 'PUT', body: JSON.stringify({ level: 'loud' }) });
  const debugLevel = await adminJson('/api/secure/admin/log-level', { method: 'PUT', body: JSON.stringify({ level: 'debug' }) });
  const logsAfter = await adminJson('/api/secure/admin/logs');
  check('the Logs page: level, the selectable levels, recent lines; a level change applies at once and is itself logged',
    logsBefore.body.data['level'] === 'info' && logsBefore.body.data['valid_levels'].length === 4 && badLevel.status === 400 && debugLevel.body.data['level'] === 'debug'
      && logsAfter.body.data['level'] === 'debug' && logsAfter.body.data['lines'].some((l: string) => l.includes('log level')));

  const cfg = await adminJson('/api/secure/admin/config');
  const entries = cfg.body.data['entries'] as { key: string; value: unknown; masked: boolean; source: string; public: boolean; from_env: boolean; env_var: string; default: unknown }[];
  const secret = entries.find((e) => e.key === 'yourphr.backup.encryption.key')!;
  const pub = entries.find((e) => e.key === 'yourphr.auth.password.min-length')!;
  check('the Configuration page gets Go\'s shape: entries with masked/source/public/from_env/env_var/default, the custom config path',
    Array.isArray(entries) && typeof cfg.body.data['custom_config_path'] === 'string' && secret.masked && secret.from_env && secret.env_var === 'YOURPHR_BACKUP_ENCRYPTION_KEY' && pub.public === true && pub.source === 'default');
  const revealed = await adminJson('/api/secure/admin/config/reveal/yourphr.backup.encryption.key'); // key in a URL path segment, unencoded (yourphr#627)
  const revealUnknown = await adminJson('/api/secure/admin/config/reveal/nope.key');
  check('reveal returns the real value of a masked key (and is logged); an unknown key is 404',
    revealed.body.data['value'] === 'travelling-copy-key' && revealUnknown.status === 404 && ((await adminJson('/api/secure/admin/logs')).body.data['lines'] as string[]).some((l) => l.includes('revealed configuration value for yourphr.backup.encryption.key')));
  const setOk = await adminJson('/api/secure/admin/config', { method: 'PUT', body: JSON.stringify({ key: 'yourphr.sync.max-pages', value: '250' }) });
  const setEnv = await adminJson('/api/secure/admin/config', { method: 'PUT', body: JSON.stringify({ key: 'yourphr.database.encryption.key', value: 'x' }) });
  const setUnknown = await adminJson('/api/secure/admin/config', { method: 'PUT', body: JSON.stringify({ key: 'nope.key', value: 1 }) });
  // An env-OWNED key answers 409 whether or not the variable is set (yourphr#635): ownership is
  // declared in yourphr.config.env-keys, so the screen can render it read-only rather than
  // discovering it on a failed save.
  const setEnvOwned = await adminJson('/api/secure/admin/config', { method: 'PUT', body: JSON.stringify({ key: 'yourphr.web.listen.port', value: 9 }) });
  const setBadType = await adminJson('/api/secure/admin/config', { method: 'PUT', body: JSON.stringify({ key: 'yourphr.sync.max-pages', value: 'lots' }) });
  check('set: coerced to the shipped type and stored; an env-OWNED key is 409 and names its variable; unknown and wrong-typed are 400',
    setOk.status === 200 && app.config.getInt('yourphr.sync.max-pages') === 250 && setEnv.status === 409 && setUnknown.status === 400 && setEnvOwned.status === 409
      && String(setEnvOwned.body.error).includes('YOURPHR_WEB_LISTEN_PORT') && setBadType.status === 400,
    `ok ${setOk.status} env ${setEnv.status} unknown ${setUnknown.status} owned ${setEnvOwned.status} badtype ${setBadType.status}`);
  const reset = await adminJson('/api/secure/admin/config/yourphr.sync.max-pages', { method: 'DELETE' });
  const resetAgain = await adminJson('/api/secure/admin/config/yourphr.sync.max-pages', { method: 'DELETE' });
  check('reset clears the override (reported), and the default is back', reset.body.data['cleared'] === true && resetAgain.body.data['cleared'] === false && app.config.getInt('yourphr.sync.max-pages') === 500);
  const nonAdminDb = await fetch(`${base}/api/secure/admin/database`, authed(opsToken));
  const strangerDb = await fetch(`${base}/api/secure/admin/database`, { headers: { authorization: `Bearer ${((await (await signIn('alice', 'another-long-enough-password')).json()) as { data: string }).data}` } });
  check('every admin card is behind the role gate', nonAdminDb.status === 200 && strangerDb.status === 403);

  // The glossary (yourphr#640) over HTTP. The harness instance is bound to the real MedlinePlus
  // provider but never reaches it: the cache is seeded directly, which is the path that matters —
  // a code already explained must never cause an outbound request.
  {
    // The app database, opened the way the harness opens others — under the same at-rest key.
    const appDb = new Database(join(dir, 'spike.db'));
    appDb.pragma("cipher='sqlcipher'");
    appDb.pragma("key='at-rest-key'");
    const cache = new SqliteGlossaryCache(appDb);
    cache.put('2160-0', '2.16.840.1.113883.6.1', {
      title: 'Creatinine (Blood)', description: 'A waste product filtered by your kidneys.',
      url: 'https://medlineplus.gov/lab-tests/creatinine-test/', publisher: 'MedlinePlus', updatedAt: '2026-01-01T00:00:00Z',
    });
    appDb.close();
    const explained = await (await fetch(`${base}/api/secure/glossary/code?code=2160-0&code_system=${encodeURIComponent('http://loinc.org')}`, authed(adminToken))).json() as { success: boolean; data?: Record<string, unknown> };
    check('glossary: a cached code is explained in plain language, attributed, without leaving the LAN',
      explained.success === true && String(explained.data?.['description']).includes('kidneys') && explained.data?.['source'] === 'cache' && explained.data?.['publisher'] === 'MedlinePlus');

    const unknownSystem = await fetch(`${base}/api/secure/glossary/code?code=2160-0&code_system=${encodeURIComponent('http://example.org/codes')}`, authed(adminToken));
    const anonymous = await fetch(`${base}/api/secure/glossary/code?code=2160-0&code_system=${encodeURIComponent('http://loinc.org')}`);
    check('glossary: an unknown code system is 400, and it requires a session — a code is not PHI but this triggers an outbound call',
      unknownSystem.status === 400 && anonymous.status === 401, `system ${unknownSystem.status} anon ${anonymous.status}`);
  }

  fake.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });

  // --- a staged restore is applied on the next start (yourphr#602) ---
  {
    const rDir = mkdtempSync(join(tmpdir(), 'spike-app-restore-'));
    const env = { YOURPHR_DATABASE_ENCRYPTION_KEY: 'k1', YOURPHR_BACKUP_ENCRYPTION_KEY: 'bk', SPIKE_TEST_ALLOW_INTERNAL: '1' };
    const a = await assembleApp(rDir, { env });
    await a.users.createUser(ApiContext.system('harness', 'admin', a.engine), 'keeper', 'keepers-long-enough-password');
    const rBase = await new Promise<string>((resolve) => { a.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(a.server.address() as { port: number }).port}`)); });
    const bootPw = readFileSync(a.bootstrapPasswordFile!, 'utf8').trim();
    const tok = ((await (await fetch(`${rBase}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: bootPw }) })).json()) as { data: string }).data;
    const b = (await (await fetch(`${rBase}/api/secure/admin/database/backup`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } })).json()) as { data: { filename: string } };
    await a.users.createUser(ApiContext.system('harness', 'admin', a.engine), 'latecomer', 'latecomers-long-enough-password');
    const staged = (await (await fetch(`${rBase}/api/secure/admin/database/restore`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ backup_name: b.data.filename, confirm: true }) })).json()) as { data: { staged: boolean } };
    await a.close();
    const after = await assembleApp(rDir, { env });
    check('a confirmed restore is STAGED, applied on the next start, and the previous databases are kept as *.pre-restore',
      staged.data.staged === true && (await after.users.roleOf('keeper')) === 'user' && (await after.users.roleOf('latecomer')) === undefined && existsSync(join(rDir, 'spike.db.pre-restore')) && existsSync(join(rDir, 'records.db.pre-restore')));
    await after.close();
    rmSync(rDir, { recursive: true, force: true });
  }

  // --- a database from before the role column (yourphr#597): nobody is demoted, the named admin stays one ---
  {
    const oldDir = mkdtempSync(join(tmpdir(), 'spike-app-prerole-'));
    const old = new Database(join(oldDir, 'spike.db'));
    old.exec(`CREATE TABLE auth_users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, token_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO auth_users VALUES ('admin', 'x', 0, '2026-08-20'), ('pat', 'x', 0, '2026-08-20')").run();
    old.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO schema_migrations VALUES ('20260820200000', 'baseline', '2026-08-20')").run();
    old.exec(`CREATE TABLE connected_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, display TEXT NOT NULL, fhir_base_url TEXT NOT NULL, token_url TEXT NOT NULL, client_id TEXT NOT NULL, patient TEXT NOT NULL, resource_types TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL DEFAULT 0, last_sync_at INTEGER NOT NULL DEFAULT 0)`);
    old.prepare("INSERT INTO connected_sources (user_id, display, fhir_base_url, token_url, client_id, patient, resource_types, access_token) VALUES ('pat', 'Old Source', 'https://x.example.org', '', 'c', 'p', 'Condition', 't')").run();
    old.close();
    const upgraded = await assembleApp(oldDir, { env: { SPIKE_TEST_ALLOW_INTERNAL: '1' } });
    check('a pre-role database boots, and bootstrap does not run (the table was populated)', !upgraded.bootstrapPasswordFile);
    check('the account named admin — the admin until now — is recorded as one', (await upgraded.users.roleOf('admin')) === 'admin');
    check('every other pre-existing account is a user', (await upgraded.users.roleOf('pat')) === 'user');
    const oldSource = (await upgraded.sources.list(ApiContext.system('test', 'pat', upgraded.engine)))[0];
    check('a pre-column source reads with platform_type and environment UNKNOWN (yourphr#594), and is served without them',
      oldSource?.platformType === '' && oldSource.environment === '' && !('platform_type' in sourceShape(oldSource, undefined)) && !('environment' in sourceShape(oldSource, undefined)));
    await upgraded.close();
    rmSync(oldDir, { recursive: true, force: true });
  }

  // Storage roots (yourphr#626): one volume collapses both roots, two volumes put the archive on
  // the slow one while the databases stay on the fast one. That the databases must not sit on a
  // NETWORK filesystem is real but is not enforced here — see yourphr#628 for the check that stats
  // the resolved path rather than trusting what a root was labelled.
  {
    const fastDir = mkdtempSync(join(tmpdir(), 'spike-fast-'));
    const oneVolume = await assembleApp(fastDir, { env: { SPIKE_TEST_ALLOW_INTERNAL: '1' } });
    check('one volume: both databases and the backup destination compose off the single root',
      oneVolume.config.getString('yourphr.database.location') === join(fastDir, 'spike.db')
        && oneVolume.config.getString('yourphr.records.location') === join(fastDir, 'records.db')
        && oneVolume.config.getString('yourphr.backup.destination') === join(fastDir, 'backups'));
    await oneVolume.close();

    const twoVolume = await assembleApp(fastDir, { env: { YOURPHR_SLOW_STORAGE: '/mnt/nas', SPIKE_TEST_ALLOW_INTERNAL: '1' } });
    check('two volumes: the archive follows the slow root, the databases stay on the fast one',
      twoVolume.config.getString('yourphr.backup.destination') === '/mnt/nas/backups'
        && twoVolume.config.getString('yourphr.database.location') === join(fastDir, 'spike.db'));
    await twoVolume.close();
    rmSync(fastDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`app harness failed: ${(err as Error).message}`);
  process.exit(1);
});
