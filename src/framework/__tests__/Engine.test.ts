import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine.js';
import { BaseManager, type BackupData } from '../BaseManager.js';

declare module '../Engine.js' {
  interface ManagerRegistry { a: Probe; b: Probe; c: Probe }
}

class Probe extends BaseManager {
  constructor(engine: Engine, readonly name: 'a' | 'b' | 'c', override readonly dependsOn: readonly ('a' | 'b' | 'c')[] = [], private readonly log: string[] = []) { super(engine); }
  override async initialize(config: Record<string, unknown> = {}): Promise<void> { this.log.push(`init ${this.name}`); await super.initialize(config); }
  override async shutdown(): Promise<void> { this.log.push(`stop ${this.name}`); await super.shutdown(); }
  async backup(): Promise<BackupData> { return { manager: this.name, takenAt: 'now' }; }
  async restore(): Promise<void> { /* nothing */ }
}

describe('Engine — the typed registry with a validated boot order', () => {
  it('initialises managers in dependency order regardless of registration order, and shuts down in reverse', async () => {
    const log: string[] = [];
    const e = new Engine();
    e.register('c', new Probe(e, 'c', ['b'], log)).register('a', new Probe(e, 'a', [], log)).register('b', new Probe(e, 'b', ['a'], log));
    await e.initialize();
    expect(log).toEqual(['init a', 'init b', 'init c']);
    expect(e.registered).toEqual(['a', 'b', 'c']);
    expect(e.managers.b.isInitialized()).toBe(true);
    expect(e.isInitialized()).toBe(true);
    await e.shutdown();
    expect(log.slice(3)).toEqual(['stop c', 'stop b', 'stop a']);
    expect(e.isInitialized()).toBe(false);
  });

  it('refuses a dependency that is not registered, by name', async () => {
    const e = new Engine();
    e.register('b', new Probe(e, 'b', ['a']));
    await expect(e.initialize()).rejects.toThrow('manager b depends on a, which is not registered');
  });

  it('refuses a dependency cycle and names it', async () => {
    const e = new Engine();
    e.register('a', new Probe(e, 'a', ['b'])).register('b', new Probe(e, 'b', ['a']));
    await expect(e.initialize()).rejects.toThrow('cycle: a -> b -> a');
  });

  it('refuses registering twice, registering after boot, and booting twice', async () => {
    const e = new Engine();
    e.register('a', new Probe(e, 'a'));
    expect(() => e.register('a', new Probe(e, 'a'))).toThrow('registered twice');
    await e.initialize();
    expect(() => e.register('b', new Probe(e, 'b'))).toThrow('after initialize()');
    await expect(e.initialize()).rejects.toThrow('called twice');
    expect(e.has('a')).toBe(true);
    expect(e.has('zzz')).toBe(false);
  });
});
