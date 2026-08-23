/**
 * The process harness (yourphr#587): src/main.ts as the orchestrator will run it — environment
 * in, a listening port out — and the refusals that make a misconfiguration a crash instead of an
 * inert pod.
 *
 *   npm run process
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { envNameFor } from '../src/config/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// node itself, not an npx/npm wrapper: a signal sent to a wrapper is reported as the wrapper dying
// (exit null) while the real process is orphaned — the CI runner showed exactly that on Linux.
const ENTRY = ['--import', 'tsx', 'src/main.ts'];

function runOnce(env: Record<string, string>): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ENTRY, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stderr: r.stderr };
}

function get(port: number, path: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForListening(child: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`did not listen within ${timeoutMs}ms; output so far:\n${out}`)), timeoutMs);
    child.stdout?.on('data', (c) => {
      out += String(c);
      if (out.includes('listening on')) { clearTimeout(timer); resolve(out); }
    });
    child.stderr?.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code} before listening:\n${out}`)); });
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-process-'));
  const dataDir = join(dir, 'data');
  const webDir = join(dir, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>YourPHR</title><app-root></app-root>');
  const DATA = envNameFor('yourphr.storage.data-dir');
  const WEB = envNameFor('yourphr.web.static-dir');
  const PORT = envNameFor('yourphr.web.listen.port');

  // --- refusals: a misconfigured process must not boot inert (yourphr#546's principle) ---
  const noData = runOnce({ [DATA]: '', [PORT]: '0' });
  check('refuses to start without a data dir, naming the variable', noData.status === 78 && noData.stderr.includes(DATA));
  const noIndex = runOnce({ [DATA]: dataDir, [WEB]: join(dir, 'nowhere'), [PORT]: '0' });
  check('refuses a static dir with no index.html, naming it', noIndex.status === 78 && noIndex.stderr.includes('index.html'));

  // --- the process ---
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ENTRY, {
    env: { ...process.env, [DATA]: dataDir, [WEB]: webDir, [PORT]: String(port), [envNameFor('yourphr.web.listen.host')]: '127.0.0.1', [envNameFor('yourphr.sync.interval-seconds')]: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    output = await waitForListening(child);
    check('boots and says where it listens, where the data is, and that the worker is off', output.includes(`127.0.0.1:${port}`) && output.includes(dataDir) && output.includes('worker off'));
    check('first start names the bootstrap password file, never the password',
      output.includes('.admin_bootstrap_password') && !output.includes(readFileSync(join(dataDir, '.admin_bootstrap_password'), 'utf8').trim()));
    check('warns loudly when the database key is unset', output.includes(envNameFor('yourphr.database.encryption.key')) && output.includes('in the clear'));

    const health = await get(port, '/healthz');
    check('GET /healthz is 200 without a session', health.status === 200 && health.body === '{"ok":true}', `${health.status} ${health.body}`);
    const index = await get(port, '/');
    check('serves the Angular index at /', index.status === 200 && index.body.includes('<app-root>'));
    const secure = await get(port, '/api/secure/summary');
    check('the API still gates: /api/secure/* is 401 without a token', secure.status === 401);
    const spa = await get(port, '/patient-profile');
    check('SPA fallback holds in the process (extensionless route -> index)', spa.status === 200 && spa.body.includes('<app-root>'));
  } catch (err) {
    check('process boot', false, (err as Error).message);
  }

  // --- shutdown ---
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<number | null>((r) => setTimeout(() => r(-1), 10_000))]);
  check('SIGTERM closes cleanly with exit 0', code === 0, `exit ${code}`);

  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`process harness failed: ${(err as Error).message}`);
  process.exit(1);
});
