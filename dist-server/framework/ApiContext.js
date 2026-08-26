export class ApiError extends Error {
    status;
    extra;
    constructor(status, message, 
    /** Extra envelope fields (Go's error_code and friends). */
    extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
        this.name = 'ApiError';
    }
}
export class ApiContext {
    engine;
    isAuthenticated;
    username;
    role;
    /** What this caller may do, resolved once from the role at construction (yourphr#620). */
    permissions;
    tokenGeneration;
    /** A named non-human caller (the migration tool, the worker); '' for a person. */
    system;
    constructor(engine, principal, system = '') {
        this.engine = engine;
        this.isAuthenticated = principal !== null;
        this.username = principal?.username ?? '';
        this.role = principal?.role ?? 'anonymous';
        // Resolved live, per request, from the role — never carried in a token (yourphr#620): a
        // demoted admin loses their powers on the next call, not when a token expires. The answer is
        // the policy manager's, which reads the operator's configured roles (yourphr#623). An engine
        // with no policy manager grants NOTHING: failing closed is the only safe direction here.
        this.permissions = Object.freeze(engine.has('policy') ? [...engine.managers.policy.permissionsFor(this.role)] : []);
        this.tokenGeneration = principal?.tokenGeneration;
        this.system = system;
        Object.freeze(this);
    }
    /** A signed-in person, from the session the transport already verified. */
    static from(principal, engine) {
        return new ApiContext(engine, principal);
    }
    /** Nobody: the public routes. */
    static anonymous(engine) {
        return new ApiContext(engine, null);
    }
    /** A named system actor acting for an account — the migration tool, the worker's sync pass. */
    static system(name, onBehalfOf, engine) {
        return new ApiContext(engine, { username: onBehalfOf, role: 'user' }, name);
    }
    /** The actor as the access log names it. */
    get actor() {
        return this.system !== '' ? this.system : this.username;
    }
    requireAuthenticated() {
        if (!this.isAuthenticated)
            throw new ApiError(401, 'unauthorized');
    }
    /** Does this caller hold the permission? The whole question, asked one way (yourphr#620). */
    can(permission) {
        return this.isAuthenticated && this.permissions.includes(permission);
    }
    /**
     * The gate: 401 when nobody is asking, 403 when somebody is but may not. The message stays the
     * Go stack's default because the Angular app reads it; a caller passes its own where Go's screen
     * says something more specific.
     */
    require(permission, message = 'admin role required') {
        this.requireAuthenticated();
        if (!this.can(permission))
            throw new ApiError(403, message);
    }
}
//# sourceMappingURL=ApiContext.js.map