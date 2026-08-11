// The system user account (NOT the FHIR Patient record). Returned by GET /api/secure/account/me
// in sanitized form (no password hash). This is the "Account Profile" identity.
export interface AccountUser {
  id?: string;
  username?: string;
  full_name?: string;
  email?: string;
  role?: string;
  picture?: string;
  /**
   * True when this session is the shared public-demo account (#496). The server derives it from
   * demo.enabled + demo.username, so the demo account's name is never published.
   *
   * A rendering hint only — the connect routes enforce the same rule server-side, because a
   * disabled button is not a control.
   */
  demo_account?: boolean;
}
