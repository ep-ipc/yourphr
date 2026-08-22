/**
 * The framework skeleton (yourphr#608, #609): the typed registry, declared dependencies with a
 * validated boot order, reverse shutdown, and the request context's guards. Each rule the
 * architecture doc tightened is checked by trying to break it.
 *
 *   npm run framework
 */
import { Engine } from '../src/framework/Engine.js';
import { BaseManager, type BackupData } from '../src/framework/BaseManager.js';
import { ApiContext, ApiError } from '../src/framework/ApiContext.js';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

declare module '../src/framework/Engine.js' {
  interface ManagerRegistry {
    alpha: Probe;
    beta: Probe;
    gamma: Probe;
  }
}

const log: string[] = [];
class Probe extends BaseManager {
  constructor(engine: Engine, readonly name: 'alpha' | 'beta' | 'gamma', override readonly dependsOn: readonly ('alpha' | 'beta' | 'gamma')[] = []) {
    super(engine);
  }
  override async initialize(config: Record<string, unknown> = {}): Promise<void> { log.push(`init ${this.name}`); await super.initialize(config); }
  override async shutdown(): Promise<void> { log.push(`stop ${this.name}`); await super.shutdown(); }
  async backup(): Promise<BackupData> { return { manager: this.name, takenAt: 'now' }; }
  async restore(): Promise<void> { /* nothing to restore */ }
}

async function main(): Promise<void> {
  // --- boot order follows declared dependencies, not registration order ---
  const e = new Engine();
  e.register('gamma', new Probe(e, 'gamma', ['beta']));
  e.register('alpha', new Probe(e, 'alpha'));
  e.register('beta', new Probe(e, 'beta', ['alpha']));
  await e.initialize();
  check('initialize() orders managers by declared dependencies, whatever the registration order',
    log.join(',') === 'init alpha,init beta,init gamma' && e.registered.join(',') === 'alpha,beta,gamma');
  check('the registry is typed: engine.managers.beta is the instance, initialised', e.managers.beta.isInitialized() && e.managers.beta.name === 'beta');
  await e.shutdown();
  check('shutdown() runs in reverse boot order', log.slice(3).join(',') === 'stop gamma,stop beta,stop alpha');

  // --- refusals ---
  let missing = '';
  try {
    const m = new Engine();
    m.register('beta', new Probe(m, 'beta', ['alpha']));
    await m.initialize();
  } catch (err) { missing = (err as Error).message; }
  check('a dependency that is not registered refuses to boot, by name', missing.includes('beta depends on alpha'));
  let cycle = '';
  try {
    const c = new Engine();
    c.register('alpha', new Probe(c, 'alpha', ['beta']));
    c.register('beta', new Probe(c, 'beta', ['alpha']));
    await c.initialize();
  } catch (err) { cycle = (err as Error).message; }
  check('a dependency cycle refuses to boot, naming the cycle', cycle.includes('cycle') && cycle.includes('alpha -> beta -> alpha'));
  let twice = '';
  try {
    const t = new Engine();
    t.register('alpha', new Probe(t, 'alpha'));
    t.register('alpha', new Probe(t, 'alpha'));
  } catch (err) { twice = (err as Error).message; }
  check('registering a manager twice is refused', twice.includes('registered twice'));

  // --- the request context ---
  const engine = new Engine();
  const member = ApiContext.from({ username: 'alice', role: 'user', tokenGeneration: 3 }, engine);
  const admin = ApiContext.from({ username: 'ops', role: 'admin' }, engine);
  const nobody = ApiContext.anonymous(engine);
  const tool = ApiContext.system('migration', 'alice', engine);
  const status = (fn: () => void): number | 'ok' => { try { fn(); return 'ok'; } catch (err) { return err instanceof ApiError ? err.status : -1; } };
  check('guards: a member passes requireAuthenticated and fails requireAdmin with 403; nobody fails with 401; an admin passes both',
    status(() => member.requireAuthenticated()) === 'ok' && status(() => member.requireAdmin()) === 403 && status(() => nobody.requireAuthenticated()) === 401 && status(() => admin.requireAdmin()) === 'ok');
  check('the authorization facts are immutable and carried (token generation included)',
    Object.isFrozen(member) && member.tokenGeneration === 3 && (() => { try { (member as { role: string }).role = 'admin'; return false; } catch { return member.role === 'user'; } })());
  check('a system principal acts for an account and names itself as the actor', tool.username === 'alice' && tool.actor === 'migration' && member.actor === 'alice' && tool.isAuthenticated);
  check('ApiError carries the status and the extra envelope fields', (() => { const x = new ApiError(403, 'nope', { error_code: 'x' }); return x.status === 403 && x.extra['error_code'] === 'x'; })());

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(`framework harness failed: ${(err as Error).stack ?? (err as Error).message}`); process.exit(1); });
