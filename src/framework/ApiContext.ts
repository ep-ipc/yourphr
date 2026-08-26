/**
 * The request context (yourphr#608): who is asking, built fresh per request from verified session
 * state and passed INTO every manager call. ngdpbase's `ApiContext`, with the doc's two
 * corrections: the authorization facts are required and immutable (a missing value must not fail
 * closed by luck), and there is no process-global context — this object lives one request.
 *
 * The engine rides on it for handler convenience (the doc's line 221). A manager never reads
 * `ctx.engine`; the store-boundary lint says so and CI proves it.
 *
 * Guards throw ApiError, which one error boundary renders in the API envelope. The messages are
 * the Go stack's, because the Angular app reads them.
 */
import type { Engine } from './Engine.js';
import type { Permission } from './policy.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Extra envelope fields (Go's error_code and friends). */
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A role name as the configuration defines it (yourphr#648); the users table stores one of these. */
export type Role = string;

/**
 * The role a CONTEXT carries. `anonymous` is a role with an empty permission list rather than an
 * `if` at the edge (yourphr#620), so the unauthenticated path goes through the same evaluator as
 * every other. It is never a stored role — the users table holds `Role`.
 */
export type ContextRole = Role | 'anonymous';

export interface Principal {
  username: string;
  role: Role;
  /** The account's token generation at verification time — the #528 revocation fact. */
  tokenGeneration?: number;
}

export class ApiContext {
  readonly engine: Engine;
  readonly isAuthenticated: boolean;
  readonly username: string;
  readonly role: ContextRole;
  /** What this caller may do, resolved once from the role at construction (yourphr#620). */
  readonly permissions: readonly Permission[];
  readonly tokenGeneration: number | undefined;
  /** A named non-human caller (the migration tool, the worker); '' for a person. */
  readonly system: string;

  private constructor(engine: Engine, principal: Principal | null, system = '') {
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
  static from(principal: Principal, engine: Engine): ApiContext {
    return new ApiContext(engine, principal);
  }

  /** Nobody: the public routes. */
  static anonymous(engine: Engine): ApiContext {
    return new ApiContext(engine, null);
  }

  /** A named system actor acting for an account — the migration tool, the worker's sync pass. */
  static system(name: string, onBehalfOf: string, engine: Engine): ApiContext {
    return new ApiContext(engine, { username: onBehalfOf, role: 'user' }, name);
  }

  /** The actor as the access log names it. */
  get actor(): string {
    return this.system !== '' ? this.system : this.username;
  }

  requireAuthenticated(): void {
    if (!this.isAuthenticated) throw new ApiError(401, 'unauthorized');
  }

  /** Does this caller hold the permission? The whole question, asked one way (yourphr#620). */
  can(permission: Permission): boolean {
    return this.isAuthenticated && this.permissions.includes(permission);
  }

  /**
   * The gate: 401 when nobody is asking, 403 when somebody is but may not. The message stays the
   * Go stack's default because the Angular app reads it; a caller passes its own where Go's screen
   * says something more specific.
   */
  require(permission: Permission, message = 'admin role required'): void {
    this.requireAuthenticated();
    if (!this.can(permission)) throw new ApiError(403, message);
  }
}
