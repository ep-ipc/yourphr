/**
 * Source + token migration harness (yourphr#584). Synthetic Go database + live loopback provider,
 * no PHI.
 *
 * The acceptance test is the issue's, verbatim: A MIGRATED SOURCE COMPLETES A WORKER
 * REFRESH+SYNC WITHOUT RECONNECTING — including discovering the token endpoint the Go stack
 * never stored.
 *
 *   npm run migrate
 */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { readGoSources, importLegacySources, resourceTypesFromScopes, WILDCARD_RESOURCE_TYPES } from '../src/migrate/index.js';
import { SourceStore, runSyncPass } from '../src/worker/index.js';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';

import { repositoryWriter } from '../src/sync/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A provider with smart-configuration discovery, a refreshing token endpoint, and gated FHIR. */
function startFakeProvider() {
  const state = { validToken: 'migrated-but-expired-token-superseded', refreshCalls: 0, discoveries: 0 };
  const server = createServer((req, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const base = `http://${req.headers.host}`;
    if (url.pathname === '/.well-known/smart-configuration') {
      state.discoveries++;
      send(200, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      state.refreshCalls++;
      state.validToken = `fresh-after-migration-${state.refreshCalls}`;
      send(200, { access_token: state.validToken, refresh_token: `rotated-${state.refreshCalls}`, token_type: 'Bearer', expires_in: 3600 });
      return;
    }
    if ((req.headers['authorization'] ?? '') !== `Bearer ${state.validToken}`) {
      send(401, { error: 'expired' });
      return;
    }
    const type = url.pathname.replace('/', '');
    send(200, { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: type, id: `${type.toLowerCase()}-m1`, code: { text: `migrated ${type}` } } }] });
  });
  return { server, state };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-migrate-'));

  // --- scope -> resource type derivation ---
  check('explicit scopes derive exactly the granted types',
    resourceTypesFromScopes('launch/patient openid patient/Condition.read patient/Observation.rs').sort().join(',') === 'Condition,Observation');
  check('a wildcard grant maps to the core set', resourceTypesFromScopes('patient/*.read').length === WILDCARD_RESOURCE_TYPES.length);
  check('no patient scopes derive no types (nothing invented)', resourceTypesFromScopes('openid fhirUser').length === 0);

  // --- the synthetic Go database, GORM shapes ---
  const fake = startFakeProvider();
  const base = await new Promise<string>((resolve) => {
    fake.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(fake.server.address() as { port: number }).port}`));
  });

  const goDb = new Database(join(dir, 'go.db'));
  goDb.exec(`CREATE TABLE users (id TEXT, username TEXT, deleted_at TEXT)`);
  goDb.exec(`CREATE TABLE source_credentials (id TEXT, user_id TEXT, display TEXT, api_endpoint_base_url TEXT, client_id TEXT,
    patient TEXT, scopes TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, environment TEXT, deleted_at TEXT)`);
  goDb.prepare("INSERT INTO users VALUES ('u-1', 'jim', NULL)").run();
  goDb.prepare("INSERT INTO users VALUES ('u-2', 'ghost', '2026-01-01')").run();
  goDb.prepare("INSERT INTO source_credentials VALUES ('src-1', 'u-1', 'Epic (Sandbox)', ?, 'cce-client', 'camila', 'launch/patient patient/Condition.read patient/Observation.read', 'migrated-but-expired-token', 'go-refresh-token', 100, 'sandbox', NULL)").run(base);
  goDb.prepare("INSERT INTO source_credentials VALUES ('src-2', 'u-1', 'Disconnected One', 'https://x.example.org', 'c', 'p', 'patient/*.read', 'a', 'r', 0, 'production', '2026-02-02')").run();
  goDb.prepare("INSERT INTO source_credentials VALUES ('src-3', 'u-2', 'Ghosts Source', 'https://y.example.org', 'c', 'p', 'patient/*.read', 'a', 'r', 0, 'production', NULL)").run();
  goDb.prepare("INSERT INTO source_credentials VALUES ('src-4', 'u-1', 'No Refresh', ?, 'c2', 'pat2', 'patient/Condition.read', 'tok2', '', 50, 'sandbox', NULL)").run(base);

  const noColumn = readGoSources(goDb);
  check('a Go schema without platform_type reads as unknown, not as a failure', noColumn.length === 2 && noColumn.every((s) => s.platformType === ''));
  goDb.exec(`ALTER TABLE source_credentials ADD COLUMN platform_type TEXT`);
  goDb.exec(`UPDATE source_credentials SET platform_type = 'ehr' WHERE id = 'src-1'`);
  goDb.exec(`UPDATE source_credentials SET platform_type = 'manual' WHERE id = 'src-4'`);
  const legacy = readGoSources(goDb);
  check('the reader joins usernames and skips soft-deleted sources AND users',
    legacy.length === 2 && legacy.every((s) => s.username === 'jim'));
  check('platform_type and environment are read (the Sources page names and groups by them, yourphr#594)',
    legacy.find((s) => s.id === 'src-4')?.platformType === 'manual' && legacy.find((s) => s.id === 'src-1')?.environment === 'sandbox');

  const appDb = new Database(join(dir, 'app.db'));
  const store = new SourceStore(appDb);
  const report = importLegacySources(store, legacy);
  check('import lands both live sources', report.imported.length === 2);
  check('and carries platform_type + environment onto the spike rows',
    store.list().find((s) => s.display === 'No Refresh')?.platformType === 'manual' && store.list().find((s) => s.display === 'Epic (Sandbox)')?.environment === 'sandbox');
  check('the Go id -> spike id map covers every live source (yourphr#586 needs it to attribute records)',
    Object.keys(report.idMap).sort().join(',') === 'src-1,src-4' && store.list().every((s) => Object.values(report.idMap).includes(s.id)));
  check('a source with no refresh token is REPORTED as needs-reconnect, not silently doomed',
    report.needsReconnect.join(',') === 'jim:No Refresh');

  const again = importLegacySources(store, legacy);
  check('re-import is one-way: everything skipped, nothing duplicated',
    again.imported.length === 0 && again.skippedExisting.length === 2 && store.list().length === 2);

  const epic = store.list().find((s) => s.display === 'Epic (Sandbox)')!;
  check('tokens, expiry and grant-derived types land verbatim',
    epic.accessToken === 'migrated-but-expired-token' && epic.refreshToken === 'go-refresh-token' &&
    epic.expiresAt === 100 && epic.resourceTypes.sort().join(',') === 'Condition,Observation' && epic.tokenUrl === '');

  // --- THE ACCEPTANCE: refresh+sync with no reconnect, discovering the endpoint on the way ---
  const repos = new Map<string, SqliteFhirRepository>();
  const repoForUser = (u: string) => {
    let r = repos.get(u);
    if (!r) { r = new SqliteFhirRepository({ file: join(dir, 'records.db'), userId: u }); repos.set(u, r); }
    return r;
  };
  const lines: string[] = [];
  const pass = await runSyncPass({ store, writerFor: (u: string, sid: string) => repositoryWriter(repoForUser(u), sid), maxPages: 5, allowInternal: true, log: (l) => lines.push(l) }, 1_000_000);
  check('THE MIGRATED SOURCE REFRESHES AND SYNCS WITHOUT A RECONNECT',
    pass.refreshed === 1 && pass.synced >= 1, JSON.stringify(pass));
  check('the token endpoint was discovered through the guarded client and persisted',
    fake.state.discoveries === 1 && store.list().find((s) => s.id === epic.id)!.tokenUrl.endsWith('/token'));
  const conditions = await repoForUser('jim').search({ resourceType: 'Condition', count: 10, total: 'accurate' });
  check('migrated-source records land under the Go username', (conditions.total ?? 0) === 1);
  check('the no-refresh source logged the reconnect signal instead of failing silently',
    lines.some((l) => l.includes('no refresh token is available; reconnect the source')));

  const secondPass = await runSyncPass({ store, writerFor: (u: string, sid: string) => repositoryWriter(repoForUser(u), sid), maxPages: 5, allowInternal: true }, 1_000_050);
  check('the second pass uses the PERSISTED endpoint — no re-discovery', fake.state.discoveries === 1 && secondPass.synced >= 1);

  fake.server.close();
  goDb.close();
  appDb.close();
  for (const r of repos.values()) r.db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`migrate harness failed: ${(err as Error).message}`);
  process.exit(1);
});
