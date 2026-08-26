/**
 * The engine (yourphr#608, #609): the composition root and the typed registry of managers —
 * ngdpbase's `Engine` + `WikiEngine`, with the mechanisms the architecture doc tightens:
 *
 *   - Typed registry. `engine.managers.records` is a compile-time error when no such manager
 *     exists; the generic-cast `getManager<T>('Name')` that returns `T | undefined` is not copied.
 *     The application augments `ManagerRegistry` with its own managers (module augmentation), so
 *     the framework never names an application resource.
 *   - Declared dependencies, validated boot order. A manager says what it `dependsOn`; initialize()
 *     orders the registry topologically and refuses a missing dependency or a cycle. A manager
 *     initialising before the configuration it reads does not silently take defaults.
 *   - No global context slot. A request context is created per request and dies with it.
 *
 * Shutdown runs in reverse boot order, so nothing is torn down before the things that use it.
 */
import type { BaseManager } from './BaseManager.js';

/** Augmented by the application: `declare module '.../framework/Engine.js' { interface ManagerRegistry { records: RecordsManager } }`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ManagerRegistry {}

export type ManagerName = keyof ManagerRegistry & string;

export class Engine {
  /** Typed access to every registered manager. Populated by register(); read after initialize(). */
  readonly managers: ManagerRegistry = {} as ManagerRegistry;
  private readonly order: ManagerName[] = [];
  private bootOrder: ManagerName[] = [];
  private initialized = false;

  register<K extends ManagerName>(name: K, manager: ManagerRegistry[K]): this {
    if (this.initialized) throw new Error(`engine: cannot register ${name} after initialize()`);
    if (name in this.managers) throw new Error(`engine: manager ${name} registered twice`);
    (this.managers as unknown as Record<string, unknown>)[name] = manager;
    this.order.push(name);
    return this;
  }

  has(name: string): name is ManagerName {
    return name in this.managers;
  }

  /** The validated boot order — what initialize() ran, for the boot log and the tests. */
  get registered(): readonly ManagerName[] {
    return this.bootOrder.length ? this.bootOrder : this.order;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Validates declared dependencies, orders the managers so every dependency initialises first,
   * and initialises them. Refuses a dependency that is not registered and a cycle — loudly, at
   * boot, rather than letting a manager run against an uninitialised sibling.
   */
  async initialize(config: Record<string, unknown> = {}): Promise<void> {
    if (this.initialized) throw new Error('engine: initialize() called twice');
    const all = this.order;
    const managerOf = (n: ManagerName): BaseManager => (this.managers as unknown as Record<string, BaseManager>)[n]!;
    for (const name of all) {
      for (const dep of managerOf(name).dependsOn) {
        if (!(dep in this.managers)) throw new Error(`engine: manager ${name} depends on ${dep}, which is not registered`);
      }
    }
    const ordered: ManagerName[] = [];
    const state = new Map<ManagerName, 'visiting' | 'done'>();
    const visit = (name: ManagerName, path: ManagerName[]): void => {
      const s = state.get(name);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`engine: dependency cycle: ${[...path, name].join(' -> ')}`);
      state.set(name, 'visiting');
      for (const dep of managerOf(name).dependsOn as ManagerName[]) visit(dep, [...path, name]);
      state.set(name, 'done');
      ordered.push(name);
    };
    for (const name of all) visit(name, []);
    this.bootOrder = ordered;
    for (const name of ordered) {
      await managerOf(name).initialize(config);
    }
    this.initialized = true;
  }

  /** Reverse boot order: a manager is never torn down before the managers that depend on it. */
  async shutdown(): Promise<void> {
    for (const name of [...this.bootOrder].reverse()) {
      await (this.managers as unknown as Record<string, BaseManager>)[name]!.shutdown();
    }
    this.initialized = false;
  }
}
