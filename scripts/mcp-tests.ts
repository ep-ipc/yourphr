/**
 * The MCP bridge, over the WIRE (yourphr#657).
 *
 *   npm run mcp-tests
 *
 * scripts/mcp-server.ts is an HTTP client with a scoped bearer token, so the only way to know what
 * it can reach is to run it: boot a real instance, mint a real agent token, speak real JSON-RPC to
 * a real child process, and try to walk past each thing it is supposed to refuse.
 *
 * A harness rather than a vitest file for the same reason scripts/agent-token-tests.ts is one:
 * `check:boundary` refuses `fetch` under src/, because Node's fetch is undici and ignores the
 * guarded DNS lookup that is the SSRF control. scripts/ is the exempt place for loopback drivers.
 *
 * THE TOOTH IS THE POINT. Both accounts below are prescribed the same drug, so "metformin" matches
 * a record in each. If the owner seam ever stops holding, one query returns two people's records
 * and this fails — which is the only version of that test worth writing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { Resource } from '@medplum/fhirtypes';
import { openStores, type Stores } from '../src/app.js';
import { createYourPhrServer } from '../src/server.js';
import { SqliteFhirRepository } from '../src/SqliteFhirRepository.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const PASSWORD = 'a-long-enough-password';
const BRIDGE = ['--import', 'tsx', 'scripts/mcp-server.ts'];

interface Harness {
  base: string;
  stores: Stores;
  server: Server;
  close: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'yourphr-mcp-'));
  const stores = await openStores(dir, {
    YOURPHR_AUTH_AGENT_TOKEN_ENABLED: 'true',
    YOURPHR_AUTH_SIGNUP_ENABLED: 'true',
  });
  const server = createYourPhrServer({ engine: stores.engine, auth: {} }) as Server;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base, stores, server,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await stores.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function signIn(base: string, username: string): Promise<string> {
  await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const res = await fetch(`${base}/api/auth/signin`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  return ((await res.json()) as { data?: string }).data ?? '';
}

async function mint(base: string, session: string, scopes: string[], name = 'Claude Desktop'): Promise<{ token: string; id: string }> {
  const res = await fetch(`${base}/api/secure/account/agent-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({ name, scopes }),
  });
  // The cleartext rides back once as `token`; the id lives on `record`, which is what revoke needs.
  const data = ((await res.json()) as { data?: { token?: string; record?: { id?: string } } }).data ?? {};
  return { token: data.token ?? '', id: data.record?.id ?? '' };
}

/** Records for one account, written the way the app writes them, so the search index is real. */
async function seed(file: string, userId: string, sourceId: string, extra: Resource): Promise<void> {
  const repo = new SqliteFhirRepository({ file, userId, sourceId });
  await repo.createResource({
    resourceType: 'MedicationRequest', id: `${userId}-m1`, status: 'active', intent: 'order',
    medicationCodeableConcept: { text: 'Metformin hydrochloride 500 MG Oral Tablet' },
    authoredOn: '2024-03-02',
  } as Resource);
  await repo.createResource(extra);
}

interface RpcResponse { id?: number; result?: Record<string, unknown>; error?: { message: string } }

/**
 * Drive the bridge as an AI client does: launch it, speak newline-delimited JSON-RPC on stdin, read
 * the replies off stdout. Returns once `wanted` responses have arrived, or the child has gone.
 */
function speak(base: string, token: string, requests: Record<string, unknown>[], wanted: number): Promise<RpcResponse[]> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, BRIDGE, {
      env: { ...process.env, YOURPHR_URL: base, YOURPHR_AGENT_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: RpcResponse[] = [];
    let buffer = '';
    const done = (): void => { child.kill(); resolve(out); };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        try { out.push(JSON.parse(line) as RpcResponse); } catch { /* not a message */ }
      }
      if (out.length >= wanted) done();
    });
    child.on('exit', () => resolve(out));
    setTimeout(done, 20_000).unref();
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  });
}

/** The text a tool call put in front of the model. */
function toolText(res: RpcResponse | undefined): string {
  const content = (res?.result?.['content'] ?? []) as { text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}

const HELLO = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harness', version: '1' } } };
const search = (id: number, query: string): Record<string, unknown> =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_records', arguments: { query } } });

async function main(): Promise<void> {
  const h = await boot();
  try {
    const recordsDb = h.stores.config.getString('yourphr.records.location');

    // Two accounts, both prescribed metformin. Only the second condition differs.
    await seed(recordsDb, 'jim', 'source-jim', {
      resourceType: 'Condition', id: 'jim-c1', code: { text: 'Prediabetes' }, recordedDate: '2024-01-11',
    } as Resource);
    await seed(recordsDb, 'dana', 'source-dana', {
      resourceType: 'Condition', id: 'dana-c1', code: { text: 'Psoriasis' }, recordedDate: '2024-02-12',
    } as Resource);

    const jimSession = await signIn(h.base, 'jim');
    await signIn(h.base, 'dana');
    check('a patient can sign in and mint a token for an agent', jimSession !== '');

    const jim = await mint(h.base, jimSession, ['Record search']);
    check('the mint returns a cleartext token, once', jim.token.startsWith('yphr_at_'), jim.token.slice(0, 12));

    // --- the handshake ---
    const hello = await speak(h.base, jim.token, [HELLO, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], 2);
    const init = hello.find((r) => r.id === 1);
    check('the bridge completes the MCP handshake',
      (init?.result?.['protocolVersion'] ?? '') === '2025-06-18');
    const tools = (hello.find((r) => r.id === 2)?.result?.['tools'] ?? []) as { name: string }[];
    check('it offers exactly one tool, and it is search_records',
      tools.length === 1 && tools[0]?.name === 'search_records', tools.map((t) => t.name).join(','));
    check('TOOTH: no write tool is offered — none exists to offer',
      !tools.some((t) => /create|update|delete|write|add/i.test(t.name)));

    // --- the read it was given ---
    const found = toolText((await speak(h.base, jim.token, [HELLO, search(2, 'metformin')], 2)).find((r) => r.id === 2));
    check('the agent reads the records the token was scoped to', found.includes('Metformin'), found.split('\n')[0] ?? '');

    // yourphr#598 indexed every record with an EMPTY sort_title and search silently matched nothing.
    // A title that is only the resource type is that failure wearing a hat.
    check('and the record carries a real title, not a bare resource type (the yourphr#598 precedent)',
      /MedicationRequest\/[^:]+: Metformin/.test(found), found.split('\n')[1] ?? '');

    // --- THE TOOTH ---
    // Counted as RESULT LINES, not occurrences of the word: the snippet highlights the match, so
    // the drug name legitimately appears twice in one hit. Counting the string tests the renderer.
    const hits = found.split('\n').filter((l) => l.startsWith('- '));
    check('TOOTH: the same drug in the other account is NOT returned — one hit, not two',
      hits.length === 1 && !found.includes('dana-'), `${hits.length} hit(s)`);
    const other = toolText((await speak(h.base, jim.token, [HELLO, search(2, 'psoriasis')], 2)).find((r) => r.id === 2));
    check("TOOTH: user A's token never returns user B's record",
      other.includes('No records matched') && !other.includes('Psoriasis'), other.split('\n')[0] ?? '');

    // --- the scope ---
    const wrongScope = await mint(h.base, jimSession, ['Medications'], 'Wrongly scoped');
    const refused = toolText((await speak(h.base, wrongScope.token, [HELLO, search(2, 'metformin')], 2)).find((r) => r.id === 2));
    check('TOOTH: a token without Record search is refused, and told which scope it needs',
      refused.includes('Record search'), refused.split('\n')[0] ?? '');

    // --- the audit, which is the reason the scope exists at all ---
    const log = (await (await fetch(`${h.base}/api/secure/account/access-log`, {
      headers: { authorization: `Bearer ${jimSession}` },
    })).json()) as { data: { actor_username: string; category: string }[] };
    check("the agent's search is logged under the AGENT's name",
      log.data.some((e) => e.actor_username === 'Claude Desktop' && e.category === 'Record search'));
    check('and is NOT attributed to the patient, who was not at the keyboard',
      !log.data.some((e) => e.actor_username === 'jim' && e.category === 'Record search'));

    // --- revocation, the property the whole design rests on ---
    await fetch(`${h.base}/api/secure/account/agent-tokens/${jim.id}/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${jimSession}` },
    });
    const dead = toolText((await speak(h.base, jim.token, [HELLO, search(2, 'metformin')], 2)).find((r) => r.id === 2));
    check('TOOTH: a revoked token stops working on the very next call, and says so plainly',
      dead.includes('revoked') && !dead.includes('Metformin'), dead.split('\n')[0] ?? '');
  } finally {
    await h.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(`mcp harness failed: ${(err as Error).stack ?? (err as Error).message}`); process.exit(1); });
