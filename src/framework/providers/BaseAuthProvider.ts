/**
 * Authentication factors (yourphr#611): a provider answers "does this credential prove this
 * account?" with a RESULT, never a boolean — the subject, which provider, the factor satisfied,
 * when, and the account's token generation, so the session that follows can be revoked
 * (yourphr#528). A provider reports; the Sessions manager turns the report into a session.
 *
 * Cardinality lives in the configuration and the manager, not here: `auth.factors` is an ALL-OF
 * list (every named factor must pass — password AND totp), `auth.providers` is the registry of
 * what is available. A provider never falls through to another: a failed factor is a failed sign-in.
 */
import type { UserRecord } from './BaseUsersProvider.js';

export interface AuthSuccess {
  ok: true;
  subject: string;
  provider: string;
  factors: string[];
  issuedAt: number;
  tokenGeneration: number;
  /** Set when the stored credential should be re-saved in this provider's current scheme (an upgrade-on-login). */
  rehash?: string;
}

export interface AuthFailure {
  ok: false;
  /** Why, for the log — never for the caller, who gets one generic message. */
  reason: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

export abstract class BaseAuthProvider {
  abstract readonly name: string;
  /**
   * Verify one factor. `stored` is the account as the users provider holds it, or undefined for an
   * unknown account — the provider must still do a real verification so timing does not answer
   * "does this account exist" (yourphr#104).
   */
  abstract authenticate(username: string, credential: string, stored: UserRecord | undefined, nowSeconds: number): Promise<AuthResult>;
  /** Produce the stored form of a new credential (a password hash). */
  abstract hash(credential: string): string;
}
