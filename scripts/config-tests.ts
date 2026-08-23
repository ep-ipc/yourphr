/**
 * Configuration-system harness (yourphr#542 Phase 4 opener; shape from yourphr#472/#473/#286).
 * Loopback only, no PHI.
 *
 *   npm run config
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envNameFor, type ConfigValue } from '../src/config/index.js';
import { Engine } from '../src/framework/Engine.js';
import { ConfigurationManager } from '../src/framework/ConfigurationManager.js';
import { FileConfigProvider } from '../src/framework/providers/FileConfigProvider.js';

/** The real two files, as an instance sees them (yourphr#621). */
function store(dir: string, env: Record<string, string> = {}, defaultsPath?: string): ConfigurationManager {
  return new ConfigurationManager(new Engine(), new FileConfigProvider(dir, defaultsPath), { env });
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function main(): void {
  // --- precedence: environment > custom > default ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    const cfg = store(dir, {});
    check('a key nobody set reads its default', cfg.getInt('auth.password.min-length') === 12);

    cfg.set('auth.password.min-length', 16);
    check('a saved setting applies to the RUNNING store, no restart', cfg.getInt('auth.password.min-length') === 16);

    const reloaded = store(dir, {});
    check('and survives a restart via the overlay', reloaded.getInt('auth.password.min-length') === 16);

    const envStore = store(dir, { [envNameFor('auth.password.min-length')]: '20' });
    check('environment outranks the overlay at read time', envStore.getInt('auth.password.min-length') === 20);

    let refused = '';
    try { envStore.set('auth.password.min-length', 8); } catch (err) { refused = (err as Error).message; }
    check('an env-pinned key refuses set() and names the variable', refused.includes(envNameFor('auth.password.min-length')));
    rmSync(dir, { recursive: true, force: true });
  }

  // --- the overlay holds only what the operator changed ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    const cfg = store(dir, {});
    cfg.set('sync.max-pages', 200);
    const overlay = JSON.parse(readFileSync(join(dir, 'config', 'app-custom-config.json'), 'utf8')) as Record<string, unknown>;
    // `_`-prefixed keys are the header comment, not settings — the same filter load() applies.
    const settings = Object.keys(overlay).filter((k) => !k.startsWith('_'));
    check('the overrides file holds ONLY the changed key, never the merged view',
      settings.length === 1 && overlay['sync.max-pages'] === 200, `wrote: ${settings.join(', ')}`);
    check('and carries the header warning an operator off pasting the defaults in',
      String(overlay['_comment']).includes('ONLY what this instance changed'));

    // A later release changes a SHIPPED default: the instance that never overrode it follows the
    // release. This only holds because the overrides carry deltas — ngdpbase's #895 in one check.
    const nextRelease = join(dir, 'next-release-defaults.json');
    const shipped = JSON.parse(readFileSync(join(process.cwd(), 'config', 'app-default-config.json'), 'utf8')) as Record<string, ConfigValue>;
    writeFileSync(nextRelease, JSON.stringify({ ...shipped, 'auth.throttle.max-failures': 8 }));
    const upgraded = store(dir, {}, nextRelease);
    check('a changed release default reaches an instance that never overrode it', upgraded.getInt('auth.throttle.max-failures') === 8);
    check('and the override the instance DID make still wins', upgraded.getInt('sync.max-pages') === 200);
    rmSync(dir, { recursive: true, force: true });
  }

  // --- refusals: unknown, bootstrap, unreadable ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
    const cfg = store(dir, {});
    let unknown = false;
    try { cfg.set('auth.password.min-legnth', 16); } catch { unknown = true; }
    check('a typo\'d key fails loudly instead of vanishing', unknown);

    let bootstrap = '';
    try { cfg.set('database.location', 'elsewhere.db'); } catch (err) { bootstrap = (err as Error).message; }
    check('a bootstrap key refuses the settings store and points at the environment', bootstrap.includes('SPIKE_DATABASE_LOCATION'));

    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'app-custom-config.json'), '{not json');
    const broken = store(dir, {});
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
    const cfg = store(dir, { [envNameFor('database.encryption.key')]: 'super-secret-cipher-key' });

    check('overlay keys the catalogue does not know are reported (yourphr#473)',
      cfg.unknownKeys().length === 1 && cfg.unknownKeys()[0] === 'sync.max-pgaes');

    const snap = cfg.snapshot();
    const secretRow = snap.find((r) => r.key === 'database.encryption.key');
    const customRow = snap.find((r) => r.key === 'sync.max-pages');
    check('snapshot masks secrets while reporting their source', secretRow?.value === '••••' && secretRow?.source === 'environment');
    check('snapshot names each key\'s source (custom vs default)',
      customRow?.source === 'custom' && snap.find((r) => r.key === 'auth.password.min-length')?.source === 'default');
    check('the secret stays readable to code that holds the door', cfg.getString('database.encryption.key') === 'super-secret-cipher-key');
    check('a bootstrap key ignores an overlay value even if one is smuggled in',
      store(dir, {}).getString('database.encryption.key') === '');
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main();
