/**
 * Frontend-serving harness (yourphr#585). Synthetic files, no PHI.
 *
 * The security tooth: a path traversal never escapes webDir. The correctness tooth: an
 * extensionless path is an Angular route (index.html), but a MISSING ASSET is an honest 404 —
 * serving index.html as main.js is the confusing failure mode SPA fallbacks invite.
 *
 *   npm run web
 */
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleApp } from '../src/app.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-web-'));
  const webDir = join(dir, 'dist');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>YourPHR</title><app-root></app-root>');
  writeFileSync(join(webDir, 'main.a1b2c3.js'), 'console.log("angular bundle")');
  writeFileSync(join(webDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'outside-secret.txt'), 'never served');

  const app = await assembleApp(dir, { env: {}, webDir });
  const base = await new Promise<string>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`));
  });

  const index = await fetch(`${base}/`);
  check('/ serves index.html as html', index.status === 200 && (index.headers.get('content-type') ?? '').includes('text/html') && (await index.text()).includes('app-root'));
  check('index.html revalidates (it names the hashed bundles)', (index.headers.get('cache-control') ?? '').includes('no-cache'));

  const route = await fetch(`${base}/web/medical-history`);
  check('an Angular route falls back to index.html (SPA)', route.status === 200 && (await route.text()).includes('app-root'));

  const bundle = await fetch(`${base}/main.a1b2c3.js`);
  check('a hashed bundle serves with its type and immutable caching',
    bundle.status === 200 && (bundle.headers.get('content-type') ?? '').includes('javascript') &&
    (bundle.headers.get('cache-control') ?? '').includes('immutable'));

  const asset = await fetch(`${base}/assets/logo.svg`);
  check('nested assets serve with their type', asset.status === 200 && (asset.headers.get('content-type') ?? '').includes('svg'));

  const missingAsset = await fetch(`${base}/main.WRONG.js`);
  check('a MISSING asset is an honest 404, never index.html-as-javascript', missingAsset.status === 404);

  // fetch() cannot test traversal: WHATWG URL normalizes ../ AND %2e%2e client-side, so the
  // server never sees the attack — a lesson this harness learned when a sabotaged guard still
  // passed. Raw sockets send the literal bytes an attacker would.
  const rawRequest = (path: string): Promise<string> =>
    new Promise((resolveRaw) => {
      const port = Number(base.split(':')[2]);
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('close', () => resolveRaw(Buffer.concat(chunks).toString('utf8')));
    });
  for (const path of ['/../outside-secret.txt', '/%2e%2e/outside-secret.txt', '/assets/../../outside-secret.txt', '/..%2foutside-secret.txt']) {
    const raw = await rawRequest(path);
    check(`traversal ${path} never escapes webDir (raw socket)`, !raw.includes('never served'), raw.split('\r\n')[0] ?? '');
  }

  const api = await fetch(`${base}/api/secure/resource/fhir?sourceResourceType=Condition`);
  check('/api/* always wins over static serving (401 from the session gate, not index.html)', api.status === 401);
  const signin = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('the sign-in route still answers as API', signin.status === 401);

  await app.close();
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`web harness failed: ${(err as Error).message}`);
  process.exit(1);
});
