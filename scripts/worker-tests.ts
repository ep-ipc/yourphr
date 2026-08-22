/**
 * Provider catalog + background sync worker harness (yourphr#542 Phase 4). Loopback fakes,
 * synthetic records, no PHI.
 *
 *   npm run worker
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { ProviderCatalog } from '../src/catalog/index.js';
import { bootSources } from './lib/boot-sources.js';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';


const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A provider that enforces bearer auth, serves bundles, and refreshes tokens — the whole loop. */
function startFakeProvider() {
  const state = {
    validToken: 'fresh-token-1',
    refreshCalls: 0,
    rotation: 1,
    failFhir: false,
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      const encoded = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(encoded);
    };

    if (url.pathname === '/token' && req.method === 'POST') {
      state.refreshCalls++;
      state.rotation++;
      state.validToken = `fresh-token-${state.rotation}`;
      send(200, {
        access_token: state.validToken,
        refresh_token: `rotated-refresh-${state.rotation}`,
        token_type: 'Bearer',
        expires_in: 3600,
      });
      return;
    }

    if (state.failFhir) {
      send(500, { error: 'provider exploded' });
      return;
    }
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${state.validToken}`) {
      send(401, { error: 'expired or unknown token' });
      return;
    }
    const type = url.pathname.replace('/', '');
    const patient = url.searchParams.get('patient') ?? 'p1';
    const entries = [1, 2, 3].map((i) => ({
      resource: { resourceType: type, id: `${type.toLowerCase()}-${patient}-${i}`, code: { text: `synthetic ${type} ${i}` } },
    }));
    send(200, { resourceType: 'Bundle', type: 'searchset', entry: entries });
  });
  return { server, state };
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-worker-'));
  const db = new Database(join(dir, 'app.db'));

  // --- catalog rules ---
  const catalog = new ProviderCatalog(db);
  const entry = catalog.create({
    display: 'Fake Sandbox', environment: 'sandbox', fhirBaseUrl: 'https://fhir.example.org/r4',
    scopes: 'patient/*.read', clientId: 'cid-1', clientSecret: 'the-secret', enabled: true,
  });
  check('a created entry reports hasClientSecret but never the secret itself',
    entry.hasClientSecret && !JSON.stringify(entry).includes('the-secret'));

  const updated = catalog.update(entry.id, {
    display: 'Fake Sandbox', environment: 'sandbox', fhirBaseUrl: 'https://fhir.example.org/r4',
    scopes: 'patient/*.read patient/Patient.read', enabled: true,
  });
  check('an update omitting the secret PRESERVES the stored one (yourphr#286)',
    updated.hasClientSecret && catalog.clientSecretFor(entry.id) === 'the-secret');

  let ssrfRefused = false;
  try {
    catalog.create({ display: 'Evil', environment: 'sandbox', fhirBaseUrl: 'http://169.254.169.254/fhir', scopes: 's' });
  } catch { ssrfRefused = true; }
  check('a catalog URL is SSRF-checked at write time, not just at dial time', ssrfRefused);

  let httpRefused = false;
  try {
    catalog.create({ display: 'Downgrade', environment: 'production', fhirBaseUrl: 'http://fhir.example.org/r4', scopes: 's' });
  } catch { httpRefused = true; }
  check('a production entry must be https', httpRefused);

  catalog.create({ display: 'Prod On', environment: 'production', fhirBaseUrl: 'https://prod.example.org/r4', scopes: 's', enabled: true });
  check('patients see enabled PRODUCTION entries only — sandboxes are admin-only',
    catalog.connectable().length === 1 && catalog.connectable()[0]?.display === 'Prod On');

  catalog.seed([{ display: 'Fake Sandbox', environment: 'sandbox', fhirBaseUrl: 'https://other.example.org', scopes: 'other', clientId: 'seed-cid' }]);
  check('seeding never clobbers an operator\'s edits (provision-then-preserve)',
    catalog.byId(entry.id)?.scopes === 'patient/*.read patient/Patient.read' && catalog.byId(entry.id)?.clientId === 'cid-1');

  // --- the worker loop against a live fake ---
  const fake = startFakeProvider();
  const base = await listen(fake.server);

  const lines: string[] = [];
  const harness = await bootSources(db, join(dir, 'records.db'), { maxPages: 10, log: (l) => lines.push(l) });
  const { sources, jobs, ctxFor } = harness;
  const repos = new Map<string, SqliteFhirRepository>();
  const repoForUser = (u: string) => {
    let r = repos.get(u);
    if (!r) { r = new SqliteFhirRepository({ file: join(dir, 'records.db'), userId: u }); repos.set(u, r); }
    return r;
  };

  const NOW = 1_000_000;
  const alice = await sources.add(ctxFor('alice'), {
    userId: 'alice', display: 'Fake Provider', fhirBaseUrl: base, tokenUrl: `${base}/token`, clientId: 'cid-1',
    patient: 'pa', resourceTypes: ['Condition', 'Observation'],
    accessToken: 'long-expired-token', refreshToken: 'refresh-1', expiresAt: NOW - 100,
  });

  const pass1 = await sources.pass(NOW);
  check('an expired token is refreshed BEFORE the sync, and the sync succeeds on the new token',
    pass1.refreshAttempted === 1 && pass1.refreshed === 1 && pass1.synced === 1 && pass1.failed === 0);
  check('the accounting line reads exactly like the production signal',
    lines.some((l) => l === 'token-refresh: attempted 1, refreshed 1'));

  const persisted = (await sources.owned(ctxFor('alice'), alice.id))!;
  check('rotated tokens are persisted (access, refresh, expiry)',
    persisted.accessToken === fake.state.validToken && persisted.refreshToken.startsWith('rotated-refresh-') && persisted.expiresAt > NOW);

  const aliceRecords = await repoForUser('alice').search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('records landed under the source\'s OWNER', (aliceRecords.total ?? 0) === 3, `${aliceRecords.total} Conditions`);

  // --- a fresh token is NOT refreshed ---
  const pass2 = await sources.pass(NOW + 10);
  check('a fresh token is left alone (refresh only near expiry)', pass2.refreshAttempted === 0 && pass2.synced === 1);
  const again = await repoForUser('alice').search({ resourceType: 'Condition', count: 100, total: 'accurate' });
  check('a worker resync creates nothing new', again.total === 3);

  // --- one failing source never costs the healthy one ---
  const failing = await sources.add(ctxFor('bob'), {
    userId: 'bob', display: 'Broken Provider', fhirBaseUrl: base, tokenUrl: `${base}/token`, clientId: 'cid-1',
    patient: 'pb', resourceTypes: ['Condition'],
    accessToken: fake.state.validToken, refreshToken: '', expiresAt: NOW + 100_000,
  });
  fake.state.failFhir = true;
  const bobOnlyPass = await sources.pass(NOW + 20);
  check('a failing provider fails BOTH syncs this pass (fake 500s for everyone) but the pass completes',
    bobOnlyPass.failed === 2 && bobOnlyPass.synced === 0);
  fake.state.failFhir = false;

  const pass3 = await sources.pass(NOW + 30);
  check('after the provider recovers, both sources sync — neither was wedged by the failure',
    pass3.synced === 2 && pass3.failed === 0);

  const bobJobs = await jobs.history(failing.id);
  check('job summaries record failure THEN success, with the error text',
    bobJobs.some((j) => j.outcome === 'failure' && j.error.includes('500')) && bobJobs.some((j) => j.outcome === 'success'));

  // --- a source with no refresh token logs the reconnect signal instead of dying silently ---
  await sources.add(ctxFor('carol'), {
    userId: 'carol', display: 'No Refresh', fhirBaseUrl: base, tokenUrl: `${base}/token`, clientId: 'cid-1',
    patient: 'pc', resourceTypes: ['Condition'],
    accessToken: 'expired-and-unrefreshable', refreshToken: '', expiresAt: NOW - 100,
  });
  await sources.pass(NOW + 40);
  check('a source with no refresh token logs the reconnect-the-source warning',
    lines.some((l) => l.includes('no refresh token is available; reconnect the source')));

  fake.server.close();
  for (const r of repos.values()) r.db.close();
  await harness.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`worker harness failed: ${(err as Error).message}`);
  process.exit(1);
});
