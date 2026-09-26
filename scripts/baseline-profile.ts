/**
 * baseline-profile — a startup + memory + response-time snapshot per release, and its drift from the
 * last one. ngdpbase's `scripts/baseline-profile.sh`, ported (2026-09-26).
 *
 * Usage:
 *   npm run test:baseline                         # measure, write docs/performance/baseline-v<ver>-<date>.md
 *   npm run test:baseline:compare                 # also diff vs the most recent prior baseline
 *   npx tsx scripts/baseline-profile.ts --compare <FILE>   # diff vs a specific file
 *
 * Thresholds — the same variables and defaults as ngdpbase; exit 1 when any trips:
 *   BASELINE_MEM_DELTA_PCT  default 25  (memory % regression)
 *   BASELINE_RT_DELTA_PCT   default 50  (route % regression)
 *   BASELINE_RT_DELTA_MS    default 50  (route absolute regression; a route is flagged only when
 *                                       BOTH its % and its ms thresholds trip, so an already-fast
 *                                       route wobbling by 1 ms is not a regression)
 *
 * Where this diverges from ngdpbase, and why:
 *
 * - It measures a server it boots itself: `e2e/server.ts`, the real app over the fixed synthetic
 *   household the E2E suite uses. ngdpbase measures its running install through `./server.sh` and
 *   pm2; YourPHR has neither locally, and a fixed data set is what makes two releases comparable.
 *   It follows that cold start is measured on every run (spawn until /api/health answers), so there
 *   is no `--cold-start` flag.
 * - Memory is the resident size of the server process (the one listening on the port), read with
 *   `ps` after sampling. There is no pm2 and no telemetry exporter to read it from.
 * - Routes are YourPHR's: the public ones, a household member's record views, and the admin
 *   Database card — which is on the list because an integrity scan in it froze a live instance on
 *   every page load (yourphr#780). A regression there is exactly what this should catch.
 * - No `--addon-diff`: YourPHR has no addons.
 * - TypeScript under tsx rather than bash, like every YourPHR tool, since the server it boots is
 *   TypeScript too.
 *
 * Needs the built Angular app (`cd frontend && yarn build -c prod`, or `make test-e2e`), because
 * e2e/server.ts refuses to start without it. Credentials are the E2E household's own test values.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_PASS, E2E_USER, ADMIN_PASS_FILE } from '../e2e/constants.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(ROOT, 'docs', 'performance');
const PORT = Number(process.env['BASELINE_PORT'] ?? 18112);
const BASE = `http://127.0.0.1:${PORT}`;
const WEB_DIR = process.env['SPIKE_E2E_WEB_DIR'] ?? join(ROOT, 'dist', 'web');
const WARMUP = 5;
const SAMPLES = 10;

const PUBLIC_ROUTES = ['/', '/api/health', '/api/instance/public'];
const MEMBER_ROUTES = ['/api/secure/summary', '/api/secure/conditions/reconciled', '/api/secure/medications/reconciled', '/api/secure/resources/recent', '/api/secure/summary/ips'];
const ADMIN_ROUTES = ['/api/secure/admin/database', '/api/secure/admin/metrics'];

export interface Snapshot {
  memoryMb: number;
  coldStartMs: number;
  /** keyed by the label the file shows: `/route`, `/route (member)`, `/route (admin)` */
  routes: Map<string, number>;
}

export interface Thresholds {
  memPct: number;
  rtPct: number;
  rtMs: number;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The file for this run: never overwrite a same-day capture of the same version — suffix -rN. */
export function outputFile(dir: string, version: string, date: string, exists: (p: string) => boolean): string {
  const first = join(dir, `baseline-v${version}-${date}.md`);
  if (!exists(first)) return first;
  let i = 2;
  while (exists(join(dir, `baseline-v${version}-${date}-r${i}.md`))) i++;
  return join(dir, `baseline-v${version}-${date}-r${i}.md`);
}

/** Read a baseline file back: memory, cold start and every route row. */
export function parseBaseline(text: string): Snapshot {
  const num = (re: RegExp): number => Number(text.match(re)?.[1] ?? NaN);
  const routes = new Map<string, number>();
  for (const m of text.matchAll(/^\| `([^`]+)`((?: \((?:member|admin)\))?) \| ([\d.]+) ms \|$/gm)) {
    routes.set(`${m[1]}${m[2]}`, Number(m[3]));
  }
  return {
    memoryMb: num(/^\| Resident memory[^|]*\| ([\d.]+) MB \|$/m),
    coldStartMs: num(/^\| Cold start[^|]*\| ([\d.]+) ms \|$/m),
    routes,
  };
}

function pct(prev: number, curr: number): number {
  return prev > 0 ? ((curr - prev) / prev) * 100 : 0;
}

function fmtDelta(prev: number | undefined, curr: number, unit: string): string {
  if (prev === undefined || Number.isNaN(prev)) return 'new';
  const d = curr - prev;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(unit === 'MB' ? 1 : 0)} ${unit} (${sign}${pct(prev, curr).toFixed(1)}%)`;
}

/** The drift section and whatever it flags. A flag is a regression candidate, not a verdict. */
export function drift(prevName: string, prev: Snapshot, curr: Snapshot, t: Thresholds): { markdown: string; flags: string[] } {
  const flags: string[] = [];
  const rows: string[] = [];
  const memWarn = !Number.isNaN(prev.memoryMb) && pct(prev.memoryMb, curr.memoryMb) > t.memPct;
  if (memWarn) flags.push(`memory ${fmtDelta(prev.memoryMb, curr.memoryMb, 'MB')}`);
  rows.push(`| Memory (after sampling) | ${Number.isNaN(prev.memoryMb) ? '-' : `${prev.memoryMb.toFixed(1)} MB`} | ${curr.memoryMb.toFixed(1)} MB | ${fmtDelta(prev.memoryMb, curr.memoryMb, 'MB')}${memWarn ? ' ⚠️' : ''} |`);
  rows.push(`| Cold start | ${Number.isNaN(prev.coldStartMs) ? '-' : `${prev.coldStartMs} ms`} | ${curr.coldStartMs} ms | ${fmtDelta(prev.coldStartMs, curr.coldStartMs, 'ms')} |`);
  for (const [route, ms] of curr.routes) {
    const before = prev.routes.get(route);
    const warn = before !== undefined && pct(before, ms) > t.rtPct && ms - before > t.rtMs;
    if (warn) flags.push(`${route} ${fmtDelta(before, ms, 'ms')}`);
    rows.push(`| \`${route.replace(/ \((member|admin)\)$/, '')}\`${route.match(/ \((member|admin)\)$/)?.[0] ?? ''} | ${before === undefined ? '-' : `${before} ms`} | ${ms} ms | ${fmtDelta(before, ms, 'ms')}${warn ? ' ⚠️' : ''} |`);
  }
  const markdown = [
    '',
    `## Drift vs ${prevName}`,
    '',
    '| Metric | Previous | New | Δ |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Thresholds (override via env): memory ${t.memPct}% / route ${t.rtPct}% AND ${t.rtMs}ms (both must trip).`,
    '',
  ].join('\n');
  return { markdown, flags };
}

// --- measuring -----------------------------------------------------------------------------------

async function waitForHealth(timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/api/health`)).status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the E2E server did not answer /api/health within ${timeoutMs / 1000}s`);
}

async function signIn(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (res.status !== 200) throw new Error(`sign-in as ${username} failed (${res.status})`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function timeRoute(route: string, cookie = ''): Promise<number> {
  const headers = cookie ? { cookie } : undefined;
  for (let i = 0; i < WARMUP; i++) await (await fetch(`${BASE}${route}`, { headers })).arrayBuffer();
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    const res = await fetch(`${BASE}${route}`, { headers });
    await res.arrayBuffer();
    if (res.status >= 400) throw new Error(`${route} answered ${res.status} — the baseline would be timing an error`);
    samples.push(performance.now() - t);
  }
  return Math.round(median(samples));
}

/**
 * Resident size, in MB, of the process listening on the port — the server itself. Not the whole
 * tree: `npx` and the tsx loader add ~150 MB that is not YourPHR's and would blur any real change.
 */
function serverRssMb(): number {
  const pid = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0];
  if (!pid) throw new Error(`nothing is listening on port ${PORT}`);
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim()) / 1024;
}

function stop(child: ChildProcess): void {
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
}

async function measure(): Promise<Snapshot> {
  if (!existsSync(join(WEB_DIR, 'index.html'))) {
    throw new Error(`no built Angular app at ${WEB_DIR} — run \`cd frontend && yarn build -c prod\` (or \`make test-e2e\`) first`);
  }
  const started = performance.now();
  const child = spawn('npx', ['tsx', 'e2e/server.ts'], {
    cwd: ROOT, detached: true, stdio: 'ignore',
    env: { ...process.env, SPIKE_E2E_PORT: String(PORT), SPIKE_E2E_WEB_DIR: WEB_DIR },
  });
  const cleanup = (): void => stop(child);
  process.on('exit', cleanup);
  try {
    await waitForHealth(120_000);
    const coldStartMs = Math.round(performance.now() - started);
    const routes = new Map<string, number>();
    for (const r of PUBLIC_ROUTES) routes.set(r, await timeRoute(r));
    const member = await signIn(E2E_USER, E2E_PASS);
    for (const r of MEMBER_ROUTES) routes.set(`${r} (member)`, await timeRoute(r, member));
    const admin = await signIn('admin', readFileSync(ADMIN_PASS_FILE, 'utf8').trim());
    for (const r of ADMIN_ROUTES) routes.set(`${r} (admin)`, await timeRoute(r, admin));
    return { memoryMb: Math.round(serverRssMb() * 10) / 10, coldStartMs, routes };
  } finally {
    cleanup();
  }
}

function render(version: string, date: string, snap: Snapshot): string {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const section = (title: string, suffix: string): string[] => {
    const rows = [...snap.routes].filter(([k]) => (suffix ? k.endsWith(suffix) : !/ \((member|admin)\)$/.test(k)));
    return ['', `## ${title}`, '', '| Route | Time |', '| --- | --- |', ...rows.map(([k, ms]) => `| \`${k.replace(/ \((member|admin)\)$/, '')}\`${suffix} | ${ms} ms |`)];
  };
  return [
    `# Performance baseline — v${version}`,
    '',
    `Captured ${date} at ${sha} against the synthetic E2E household (\`e2e/server.ts\`), Node ${process.version}.`,
    '',
    '## Snapshot',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Version | v${version} |`,
    `| Resident memory (after sampling) | ${snap.memoryMb.toFixed(1)} MB |`,
    `| Cold start (spawn until /api/health answers) | ${snap.coldStartMs} ms |`,
    ...section('Response times, public (median of 10)', ''),
    ...section('Response times, household member (median of 10)', ' (member)'),
    ...section('Response times, admin (median of 10)', ' (admin)'),
    '',
    '## Methodology',
    '',
    `Generated by \`scripts/baseline-profile.ts\`, ported from ngdpbase's \`baseline-profile.sh\`. It boots \`e2e/server.ts\` — the real app over the fixed synthetic household the E2E suite uses — so two releases are measured against the same data. Cold start is the time from spawning it until \`/api/health\` answers, which includes seeding the household and its first sync. Each route gets ${WARMUP} discarded warm-up requests, then the MEDIAN of ${SAMPLES} timed ones; a route that answers an error fails the run rather than being timed. Member routes are signed in as the E2E member, admin routes as the instance's generated admin. Memory is the resident size of the server process — the one listening on the port, not the \`npx\`/tsx wrappers around it — read with \`ps\` after sampling. Numbers are for comparing releases on one machine, not for sizing a deployment: a real household's database is far larger.`,
    '',
  ].join('\n');
}

/** The newest baseline in the folder other than `except`, by modification time. */
function previousBaseline(except: string): string | undefined {
  if (!existsSync(OUT_DIR)) return undefined;
  return readdirSync(OUT_DIR)
    .filter((f) => /^baseline-v.*\.md$/.test(f) && join(OUT_DIR, f) !== except)
    .map((f) => join(OUT_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const compareAt = args.indexOf('--compare');
  const compare = compareAt >= 0;
  const explicitPrev = compare && args[compareAt + 1] && !args[compareAt + 1]!.startsWith('--') ? resolve(args[compareAt + 1]!) : undefined;

  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const date = new Date().toISOString().split('T')[0]!;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = outputFile(OUT_DIR, version, date, existsSync);

  console.log(`→ Measuring v${version} against the synthetic E2E household on port ${PORT}…`);
  const snap = await measure();
  writeFileSync(file, render(version, date, snap));
  console.log(`✓ wrote ${file.replace(ROOT + '/', '')}`);

  if (!compare) return;
  const prevFile = explicitPrev ?? previousBaseline(file);
  if (!prevFile) {
    console.log('no prior baseline to compare against');
    return;
  }
  const thresholds: Thresholds = {
    memPct: Number(process.env['BASELINE_MEM_DELTA_PCT'] ?? 25),
    rtPct: Number(process.env['BASELINE_RT_DELTA_PCT'] ?? 50),
    rtMs: Number(process.env['BASELINE_RT_DELTA_MS'] ?? 50),
  };
  const { markdown, flags } = drift(basename(prevFile), parseBaseline(readFileSync(prevFile, 'utf8')), snap, thresholds);
  appendFileSync(file, markdown);
  console.log(markdown);
  if (flags.length) {
    console.error(`⚠️  regression candidate(s): ${flags.join('; ')}`);
    process.exit(1);
  }
}

const argvPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (argvPath === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`baseline: ${(err as Error).message}`);
    process.exit(1);
  });
}
