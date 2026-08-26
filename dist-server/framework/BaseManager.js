export class BaseManager {
    engine;
    /** Managers that must initialise first. The engine validates and orders. */
    dependsOn = [];
    initialized = false;
    config = {};
    constructor(engine) {
        this.engine = engine;
    }
    async initialize(config = {}) {
        this.config = config;
        this.initialized = true;
    }
    isInitialized() {
        return this.initialized;
    }
    async shutdown() {
        this.initialized = false;
    }
}
//# sourceMappingURL=BaseManager.js.map