export class Engine {
    /** Typed access to every registered manager. Populated by register(); read after initialize(). */
    managers = {};
    order = [];
    bootOrder = [];
    initialized = false;
    register(name, manager) {
        if (this.initialized)
            throw new Error(`engine: cannot register ${name} after initialize()`);
        if (name in this.managers)
            throw new Error(`engine: manager ${name} registered twice`);
        this.managers[name] = manager;
        this.order.push(name);
        return this;
    }
    has(name) {
        return name in this.managers;
    }
    /** The validated boot order — what initialize() ran, for the boot log and the tests. */
    get registered() {
        return this.bootOrder.length ? this.bootOrder : this.order;
    }
    isInitialized() {
        return this.initialized;
    }
    /**
     * Validates declared dependencies, orders the managers so every dependency initialises first,
     * and initialises them. Refuses a dependency that is not registered and a cycle — loudly, at
     * boot, rather than letting a manager run against an uninitialised sibling.
     */
    async initialize(config = {}) {
        if (this.initialized)
            throw new Error('engine: initialize() called twice');
        const all = this.order;
        const managerOf = (n) => this.managers[n];
        for (const name of all) {
            for (const dep of managerOf(name).dependsOn) {
                if (!(dep in this.managers))
                    throw new Error(`engine: manager ${name} depends on ${dep}, which is not registered`);
            }
        }
        const ordered = [];
        const state = new Map();
        const visit = (name, path) => {
            const s = state.get(name);
            if (s === 'done')
                return;
            if (s === 'visiting')
                throw new Error(`engine: dependency cycle: ${[...path, name].join(' -> ')}`);
            state.set(name, 'visiting');
            for (const dep of managerOf(name).dependsOn)
                visit(dep, [...path, name]);
            state.set(name, 'done');
            ordered.push(name);
        };
        for (const name of all)
            visit(name, []);
        this.bootOrder = ordered;
        for (const name of ordered) {
            await managerOf(name).initialize(config);
        }
        this.initialized = true;
    }
    /** Reverse boot order: a manager is never torn down before the managers that depend on it. */
    async shutdown() {
        for (const name of [...this.bootOrder].reverse()) {
            await this.managers[name].shutdown();
        }
        this.initialized = false;
    }
}
//# sourceMappingURL=Engine.js.map