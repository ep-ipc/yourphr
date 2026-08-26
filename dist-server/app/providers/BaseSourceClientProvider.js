/** Where a client call failed — the manager turns the stage into the caller-facing message. */
export class SourceClientError extends Error {
    stage;
    constructor(stage, message) {
        super(message);
        this.stage = stage;
    }
}
export class BaseSourceClientProvider {
}
/** The inert default: nothing is reached, and every attempt says so rather than pretending. */
export class NullSourceClientProvider extends BaseSourceClientProvider {
    name = 'null';
    refuse(what) {
        throw new SourceClientError('unavailable', `no source client is configured (sources.client.provider = null): ${what}`);
    }
    async beginAuthorization() { return this.refuse('a provider cannot be authorized'); }
    async completeAuthorization() { return this.refuse('a provider cannot be connected'); }
    async refresh() { return this.refuse('tokens cannot be refreshed'); }
    async fetchPages() { return this.refuse('nothing can be synced'); }
}
//# sourceMappingURL=BaseSourceClientProvider.js.map