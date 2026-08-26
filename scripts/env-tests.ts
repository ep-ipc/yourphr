/**
 * The bootstrap environment (yourphr#630): `.env` loaded before anything else, with ngdpbase's
 * precedence. Runs the real module in a child process, because it is a side-effecting import
 * evaluated once — testing it in-process would prove nothing about the ordering that is its point.
 *
 *   npm run env
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Boot the real module in a child process and report what it put in the environment. */
function boot(cwd: string, env: Record<string, string>, keys: string[]): Record<string, string> {
  const probe = join(cwd, 'probe.mjs');
  writeFileSync(probe, `import '${join(process.cwd(), 'dist', 'bootstrap-env.js')}';
console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k] ?? null]))));`);
  const out = execFileSync(process.execPath, [probe], { cwd, env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim()) as Record<string, string>;
}

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'yourphr-env-')); dirs.push(d); return d; };

function main(): void {
  // 1. the repo-root .env is read
  {
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'YOURPHR_OPERATOR_NAME=from-root\n');
    check('a .env beside the app is read — the direct-install case',
      boot(dir, {}, ['YOURPHR_OPERATOR_NAME'])['YOURPHR_OPERATOR_NAME'] === 'from-root');
  }

  // 2. the per-instance file on the data volume is read, and beats the root file
  {
    const dir = tmp();
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(dir, '.env'), 'YOURPHR_FAST_STORAGE=./data\nYOURPHR_OPERATOR_NAME=from-root\n');
    writeFileSync(join(data, '.env'), 'YOURPHR_OPERATOR_NAME=from-volume\n');
    const got = boot(dir, {}, ['YOURPHR_OPERATOR_NAME']);
    check('a .env on the data volume is read, and outranks the root file — the container case',
      got['YOURPHR_OPERATOR_NAME'] === 'from-volume', String(got['YOURPHR_OPERATOR_NAME']));
  }

  // 3. the ambient environment outranks both — what makes the migration off a k8s Secret safe
  {
    const dir = tmp();
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(dir, '.env'), 'YOURPHR_OPERATOR_NAME=from-root\n');
    writeFileSync(join(data, '.env'), 'YOURPHR_OPERATOR_NAME=from-volume\n');
    const got = boot(dir, { YOURPHR_OPERATOR_NAME: 'from-ambient' }, ['YOURPHR_OPERATOR_NAME']);
    check('the ambient environment outranks every file — so a Secret keeps winning until it is removed',
      got['YOURPHR_OPERATOR_NAME'] === 'from-ambient', String(got['YOURPHR_OPERATOR_NAME']));
  }

  // 4. the root file may DECLARE where the instance file lives
  {
    const dir = tmp();
    const data = join(dir, 'elsewhere');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(dir, '.env'), `YOURPHR_FAST_STORAGE=${data}\n`);
    writeFileSync(join(data, '.env'), 'YOURPHR_OPERATOR_NAME=from-declared\n');
    check('the root file may declare YOURPHR_FAST_STORAGE, and the instance file is found there',
      boot(dir, {}, ['YOURPHR_OPERATOR_NAME'])['YOURPHR_OPERATOR_NAME'] === 'from-declared');
  }

  // 5. no files at all is normal, not fatal
  {
    const dir = tmp();
    check('an instance with no .env anywhere starts — ./data is the default, so unpack-and-run works',
      boot(dir, {}, ['YOURPHR_OPERATOR_NAME'])['YOURPHR_OPERATOR_NAME'] === null);
  }

  // 6. the pre-#630 variable name still locates the instance file
  {
    const dir = tmp();
    const data = join(dir, 'legacy');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, '.env'), 'YOURPHR_OPERATOR_NAME=from-legacy-root\n');
    check('the pre-#630 YOURPHR_STORAGE_DATA_DIR still locates the instance file — a running deployment keeps booting',
      boot(dir, { YOURPHR_STORAGE_DATA_DIR: data }, ['YOURPHR_OPERATOR_NAME'])['YOURPHR_OPERATOR_NAME'] === 'from-legacy-root');
  }

  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main();
