/**
 * DCR harness (yourphr#581). Loopback fake, synthetic values, no PHI.
 *
 * The tooth that matters: a registration response carrying a redirect URI we never requested is a
 * code-steal vector and must be refused whole — not filtered, not warned about, refused.
 *
 *   npm run dcr
 */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { registerDynamicClient, DynamicClientStore } from '../src/dcr/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

type Mode = 'happy' | 'no-client-id' | 'extra-redirect' | 'echo-subset';
const state: { mode: Mode; lastAuth: string; lastBody?: Record<string, unknown> } = { mode: 'happy', lastAuth: '' };

function startFakeRegistrar() {
  return createServer((req, res: ServerResponse) => {
    state.lastAuth = String(req.headers['authorization'] ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      state.lastBody = body;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const requested = body['redirect_uris'] as string[];
      switch (state.mode) {
        case 'happy':
          send(201, { client_id: 'dyn-client-123', client_secret: '', registration_access_token: 'reg-tok',
            registration_client_uri: 'https://example.org/register/dyn-client-123', redirect_uris: requested });
          return;
        case 'echo-subset':
          send(201, { client_id: 'dyn-client-sub', redirect_uris: [requested[0]] });
          return;
        case 'no-client-id':
          send(201, { redirect_uris: requested });
          return;
        case 'extra-redirect':
          send(201, { client_id: 'dyn-evil', redirect_uris: [...requested, 'https://attacker.example/callback'] });
          return;
      }
    });
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-dcr-'));
  const server = startFakeRegistrar();
  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  const REDIRECTS = ['https://relay.example.org/callback'];

  // --- endpoint validation: the same gauntlet as the token endpoint ---
  for (const [label, endpoint] of [
    ['cloud metadata', 'http://169.254.169.254/register'],
    ['loopback (guard ON)', 'http://127.0.0.1/register'],
    ['private address', 'https://10.0.0.5/register'],
  ] as const) {
    let refused = false;
    try {
      await registerDynamicClient({ registrationEndpoint: endpoint, baseIsHttps: true, clientName: 'x', redirectUris: REDIRECTS });
    } catch { refused = true; }
    check(`a registration endpoint at ${label} is refused before any request is sent`, refused);
  }
  let downgrade = false;
  try {
    await registerDynamicClient({ registrationEndpoint: 'http://reg.example.org/register', baseIsHttps: true, clientName: 'x', redirectUris: REDIRECTS });
  } catch (err) { downgrade = (err as Error).message.includes('downgrade'); }
  check('an http endpoint against an https base is refused as a downgrade', downgrade);

  // --- happy path ---
  state.mode = 'happy';
  const client = await registerDynamicClient({
    registrationEndpoint: `${base}/register`, baseIsHttps: false, clientName: 'YourPHR spike',
    redirectUris: REDIRECTS, initialAccessToken: 'initial-tok', allowInternal: true,
  });
  check('a registration yields the per-installation client_id', client.clientId === 'dyn-client-123');
  check('the initial access token authorized the registration (Epic pattern)', state.lastAuth === 'Bearer initial-tok');
  check('the request asked for the refresh grant as a public client',
    JSON.stringify(state.lastBody?.['grant_types']) === '["authorization_code","refresh_token"]' &&
    state.lastBody?.['token_endpoint_auth_method'] === 'none');

  const db = new Database(join(dir, 'dcr.db'));
  const store = new DynamicClientStore(db);
  store.save(7, client);
  check('the dynamic client persists per source and reads back',
    store.forSource(7)?.clientId === 'dyn-client-123' && store.forSource(8) === undefined);
  const rotated = { ...client, clientId: 'dyn-client-456' };
  store.save(7, rotated);
  check('re-registration replaces the stored client (one per source)', store.forSource(7)?.clientId === 'dyn-client-456');

  // --- refusals with teeth ---
  state.mode = 'no-client-id';
  let noId = false;
  try {
    await registerDynamicClient({ registrationEndpoint: `${base}/register`, baseIsHttps: false, clientName: 'x', redirectUris: REDIRECTS, allowInternal: true });
  } catch (err) { noId = (err as Error).message.includes('no client_id'); }
  check('a response without client_id is refused as not-a-registration', noId);

  state.mode = 'extra-redirect';
  let extra = false;
  try {
    await registerDynamicClient({ registrationEndpoint: `${base}/register`, baseIsHttps: false, clientName: 'x', redirectUris: REDIRECTS, allowInternal: true });
  } catch (err) { extra = (err as Error).message.includes('code-steal'); }
  check('A REDIRECT URI WE NEVER REQUESTED REFUSES THE WHOLE REGISTRATION', extra);

  state.mode = 'echo-subset';
  const subset = await registerDynamicClient({
    registrationEndpoint: `${base}/register`, baseIsHttps: false, clientName: 'x',
    redirectUris: [...REDIRECTS, 'https://relay.example.org/alt'], allowInternal: true,
  });
  check('a server narrowing to a SUBSET of requested URIs is acceptable', subset.clientId === 'dyn-client-sub');

  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`dcr harness failed: ${(err as Error).message}`);
  process.exit(1);
});
