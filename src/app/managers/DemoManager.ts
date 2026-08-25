/**
 * Demo mode (yourphr#643): the shared account a public demo signs every visitor into, the one-click
 * entrance that does it, and the restriction that makes the arrangement safe.
 *
 * Three facts, one owner. Go spread them over `pkg/demo` (provisioning), an auth handler (the
 * entrance) and a middleware (the restriction), and the three had to agree about what "the demo
 * account" means. Here they are one manager, because they are one rule read three ways: THIS
 * instance is a demo, THIS account is the demo's, and that account may not bring outside data in.
 *
 * WHY THE CREDENTIAL IS GENERATED. `POST /api/auth/demo-signin` posts nothing — the server verifies
 * the configured password against the stored hash and mints the session — so no visitor ever needs
 * to know one. A human-chosen value bought only the ability to type it at the sign-in form, which
 * nobody does, and it cost twice in Go: the seeded `demo123` was shorter than the product's own
 * minimum (yourphr#505), and its replacement collided with the policy that forbids the username
 * inside the password (yourphr#506). A value shipped inside a public image is a published
 * credential identical on every deployment; generated per instance, it is neither.
 *
 * WHY THE VERIFY SURVIVES. Minting a token for whoever `yourphr.demo.username` names would be
 * simpler and would turn one mis-set flag into an auth bypass: demo mode switched on by an operator
 * exploring the Configuration screen, on an instance that happens to hold an account called `demo`,
 * would hand a stranger that account's records. The configured password must verify against the
 * stored hash, so a flag flipped without provisioning does nothing at all.
 *
 * NOT FATAL AT BOOT. A demo that cannot provision is a demo with no way in — worth a loud log line,
 * not worth refusing to start over. Contrast the bootstrap admin (yourphr#504), where failing to
 * provision leaves an instance reachable and unowned.
 */
import { randomBytes } from 'node:crypto';
import { BaseManager, type BackupData } from '../../framework/BaseManager.js';
import type { Engine } from '../../framework/Engine.js';
import { ApiError, type ApiContext } from '../../framework/ApiContext.js';

declare module '../../framework/Engine.js' {
  interface ManagerRegistry {
    demo: DemoManager;
  }
}

/**
 * The frontend recognises a demo refusal by this code rather than by string-matching a sentence
 * (Go's `middleware.DemoErrorCode`), so it is wire format and keeps Go's spelling — including the
 * envelope field being `code` here where the consent refusal uses `error_code`.
 */
export const DEMO_ERROR_CODE = 'demo_account_restricted';

/** 24 random bytes — 192 bits, 32 printable characters. Nobody types it, so nothing argues for less. */
const CREDENTIAL_BYTES = 24;

export const ENABLED_KEY = 'yourphr.demo.enabled';
export const USERNAME_KEY = 'yourphr.demo.username';
export const PASSWORD_KEY = 'yourphr.demo.password';

export class DemoManager extends BaseManager {
  readonly name = 'demo';
  override readonly dependsOn = ['configuration', 'users', 'sessions'] as const;

  constructor(engine: Engine, private readonly log: (line: string) => void = () => undefined) {
    super(engine);
  }

  private get configuration() {
    return this.engine.managers.configuration;
  }

  /** Is this instance a public demo at all? False on every ordinary install, which is the shipped default. */
  get enabled(): boolean {
    return this.configuration.getBool(ENABLED_KEY);
  }

  /** The account visitors are signed into. Never published — the wire carries the flag, not the name. */
  get username(): string {
    return this.configuration.getString(USERNAME_KEY);
  }

  /**
   * Is this the shared demo account? Keyed on demo mode AND the name, not the flag alone, so the
   * operator's own account keeps full function on the same instance — which is how the demo's seed
   * data gets refreshed without switching demo mode off and on again.
   */
  isDemoAccount(username: string): boolean {
    return this.enabled && this.username !== '' && username === this.username;
  }

  /** Whether THIS caller is the shared account — what `demo_account` on `/account/me` reports. */
  isDemoSession(ctx: ApiContext): boolean {
    return ctx.isAuthenticated && this.isDemoAccount(ctx.username);
  }

  /**
   * The restriction (yourphr#496), and the reason demo mode is safe to run in public: the demo
   * account is SHARED, so a visitor who connects their own real Epic or Medicare account would put
   * their claims and conditions in front of the next visitor — real PHI, on a public login. Called
   * by the managers that own bringing outside data in, never by a route: a hidden button is not a
   * control, and the routes answer curl whatever the UI renders.
   */
  refuseConnect(ctx: ApiContext): void {
    if (!this.isDemoSession(ctx)) return;
    throw new ApiError(403,
      'connecting a provider is disabled in the public demo — the demo account is shared, so records imported here would be visible to everyone',
      { code: DEMO_ERROR_CODE });
  }

  /**
   * The one-click entrance. Verifies the CONFIGURED password against the stored hash and mints a
   * session for it; the caller supplies nothing. Every refusal says the same generic thing, because
   * the difference between "not enabled here", "no such account" and "the credential drifted" is an
   * operator's to read in the log, not a visitor's to probe from outside.
   */
  async signIn(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    const refused = { ok: false, error: 'demo mode is not configured on this instance' } as const;
    if (!this.enabled) return { ok: false, error: 'demo mode is not enabled on this instance' };

    const username = this.username;
    const password = this.configuredPassword();
    if (username === '' || password === '') {
      // Since provisioning, an empty value here means the demo account did not exist when this
      // instance last started — so say what the fix is, on the server, where the operator looks.
      this.log(`demo sign-in refused: ${username === '' ? USERNAME_KEY : PASSWORD_KEY} is empty (the credential is provisioned at startup — create the account and restart)`);
      return refused;
    }
    if (!(await this.engine.managers.users.passwordMatches(username, password))) {
      this.log(`demo sign-in refused: ${PASSWORD_KEY} does not match the ${JSON.stringify(username)} account`);
      return refused;
    }
    const token = await this.engine.managers.sessions.issueFor(username);
    if (token === undefined) {
      this.log(`demo sign-in refused: no account named ${JSON.stringify(username)} exists`);
      return refused;
    }
    return { ok: true, token };
  }

  /**
   * Boot: make sure the demo account carries a password this process generated and nobody knows,
   * and that `yourphr.demo.password` holds it.
   *
   * IDEMPOTENT. The normal path on every restart is "the configured password already verifies", and
   * this touches nothing. It regenerates only when the two have drifted apart — which is exactly
   * what a freshly restored seed looks like, so a reset needs no operator step.
   *
   * ORDER. The account is updated first: if the config write then fails, the configured value no
   * longer verifies, so the next boot regenerates and the drift heals itself. What must never
   * happen is treating a mismatch as "no password required", which is why signIn() refuses rather
   * than falling back.
   */
  async provision(): Promise<void> {
    if (!this.enabled) return;
    const username = this.username;
    if (username === '') {
      this.log(`demo mode is enabled but ${USERNAME_KEY} is empty; no demo credential was provisioned`);
      return;
    }
    const existing = this.configuredPassword();
    if (existing !== '' && (await this.engine.managers.users.passwordMatches(username, existing))) return;

    const password = randomBytes(CREDENTIAL_BYTES).toString('base64url');
    if (!(await this.engine.managers.users.provisionPassword(username, password))) {
      // Reachable and expected where demo mode was switched on before the demo account exists.
      this.log(`demo mode is enabled but no account named ${JSON.stringify(username)} exists; no demo credential was provisioned`);
      return;
    }
    try {
      this.configuration.set(PASSWORD_KEY, password);
    } catch (err) {
      // The one unrecoverable case is an operator pinning the password in the environment: the
      // account now carries a password nothing knows, and this cannot record the new one. Say so
      // with the fix in it rather than leaving a demo that refuses every visitor for no stated
      // reason. Never log the value itself.
      this.log(`demo credential: set a new password on ${JSON.stringify(username)} but could not record it in ${PASSWORD_KEY} (${(err as Error).message})`);
      return;
    }
    this.log(`demo credential: generated a new password for ${JSON.stringify(username)} and stored it in ${PASSWORD_KEY}`);
  }

  /** The configured value, read as a secret would be — the raw value, never the mask. */
  private configuredPassword(): string {
    return this.configuration.getString(PASSWORD_KEY);
  }

  // --- the base contract ---

  async backup(): Promise<BackupData> {
    // Nothing of its own: the flag and the name are configuration, the credential is provisioned
    // at boot, and the account itself travels with the app database.
    return { manager: this.name, takenAt: new Date().toISOString(), payload: {} };
  }

  async restore(): Promise<void> {
    throw new ApiError(501, 'demo mode is configuration and a provisioned credential, not restorable state');
  }
}
