import { describe, expect, it } from 'vitest';
import { Engine } from '../Engine.js';
import { BaseManager } from '../BaseManager.js';
class Probe extends BaseManager {
    name;
    dependsOn;
    log;
    constructor(engine, name, dependsOn = [], log = []) {
        super(engine);
        this.name = name;
        this.dependsOn = dependsOn;
        this.log = log;
    }
    async initialize(config = {}) { this.log.push(`init ${this.name}`); await super.initialize(config); }
    async shutdown() { this.log.push(`stop ${this.name}`); await super.shutdown(); }
    async backup() { return { manager: this.name, takenAt: 'now' }; }
    async restore() { }
}
describe('Engine — the typed registry with a validated boot order', () => {
    it('initialises managers in dependency order regardless of registration order, and shuts down in reverse', async () => {
        const log = [];
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
//# sourceMappingURL=Engine.test.js.map