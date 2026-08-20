/**
 * Configuration-system harness (yourphr#542 Phase 4 opener; shape from yourphr#472/#473/#286).
 * Loopback only, no PHI.
 *
 *   npm run config
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, DefaultConfigSpec, envNameFor } from '../src/config/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function main(): void {
  // --- precedence: environment > custom > default ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    const store = new ConfigStore(dir, DefaultConfigSpec, {});
    check('a key nobody set reads its default', store.getInt('auth.password.min-length') === 12);

    store.set('auth.password.min-length', 16);
    check('a saved setting applies to the RUNNING store, no restart', store.getInt('auth.password.min-length') === 16);

    const reloaded = new ConfigStore(dir, DefaultConfigSpec, {});
    check('and survives a restart via the overlay', reloaded.getInt('auth.password.min-length') === 16);

    const envStore = new ConfigStore(dir, DefaultConfigSpec, { [envNameFor('auth.password.min-length')]: '20' });
    check('environment outranks the overlay at read time', envStore.getInt('auth.password.min-length') === 20);

    let refused = '';
    try { envStore.set('auth.password.min-length', 8); } catch (err) { refused = (err as Error).message; }
    check('an env-pinned key refuses set() and names the variable', refused.includes(envNameFor('auth.password.min-length')));
    rmSync(dir, { recursive: true, force: true });
  }

  // --- the overlay holds only what the operator changed ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    const store = new ConfigStore(dir, DefaultConfigSpec, {});
    store.set('sync.max-pages', 200);
    const overlay = JSON.parse(readFileSync(join(dir, 'config', 'app-custom-config.json'), 'utf8')) as Record<string, unknown>;
    check('the overlay file holds ONLY the changed key, never the merged view',
      Object.keys(overlay).length === 1 && overlay['sync.max-pages'] === 200);

    // A later release changes a default: the instance that never overrode it follows the release.
    const nextRelease = { ...DefaultConfigSpec, 'auth.throttle.max-failures': { ...DefaultConfigSpec['auth.throttle.max-failures']!, default: 8 } };
    const upgraded = new ConfigStore(dir, nextRelease, {});
    check('a changed release default reaches an instance that never overrode it', upgraded.getInt('auth.throttle.max-failures') === 8);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- refusals: unknown, bootstrap, unreadable ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    const store = new ConfigStore(dir, DefaultConfigSpec, {});
    let unknown = false;
    try { store.set('auth.password.min-legnth', 16); } catch { unknown = true; }
    check('a typo\'d key fails loudly instead of vanishing', unknown);

    let bootstrap = '';
    try { store.set('database.location', 'elsewhere.db'); } catch (err) { bootstrap = (err as Error).message; }
    check('a bootstrap key refuses the settings store and points at the environment', bootstrap.includes('SPIKE_DATABASE_LOCATION'));

    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'app-custom-config.json'), '{not json');
    const broken = new ConfigStore(dir, DefaultConfigSpec, {});
    let overwriteRefused = false;
    try { broken.set('sync.max-pages', 100); } catch { overwriteRefused = true; }
    check('an unparseable overlay is never overwritten', overwriteRefused);
    check('and is reported, not silently ignored', broken.unknownKeys()[0]?.startsWith('<unreadable') === true);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- unknown-key report + snapshot ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'app-custom-config.json'), JSON.stringify({ 'sync.max-pages': 300, 'sync.max-pgaes': 400 }));
    const store = new ConfigStore(dir, DefaultConfigSpec, { [envNameFor('database.encryption.key')]: 'super-secret-cipher-key' });

    check('overlay keys the catalogue does not know are reported (yourphr#473)',
      store.unknownKeys().length === 1 && store.unknownKeys()[0] === 'sync.max-pgaes');

    const snap = store.snapshot();
    const secretRow = snap.find((r) => r.key === 'database.encryption.key');
    const customRow = snap.find((r) => r.key === 'sync.max-pages');
    check('snapshot masks secrets while reporting their source', secretRow?.value === '••••' && secretRow?.source === 'environment');
    check('snapshot names each key\'s source (custom vs default)',
      customRow?.source === 'custom' && snap.find((r) => r.key === 'auth.password.min-length')?.source === 'default');
    check('the secret stays readable to code that holds the store', store.getString('database.encryption.key') === 'super-secret-cipher-key');
    check('a bootstrap key ignores an overlay value even if one is smuggled in',
      new ConfigStore(dir, DefaultConfigSpec, {}).getString('database.encryption.key') === '');
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main();
