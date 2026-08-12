// The instance's password policy, published by GET /api/instance/public (#506).
//
// The forms build their validators from this so they cannot drift from what the server enforces.
// Before it existed, sign-in required 2 characters while telling the user 4, sign-up required 4, and
// the server required nothing at all — so the API accepted passwords its own login form refused.
export interface PasswordPolicy {
  password_min_length: number;
  password_max_length: number;
  password_deny_common: boolean;
  password_deny_username: boolean;
  username_min_length: number;
}

// Mirrors the shipped defaults in app-default-config.json. Used only until the instance answers, and
// on error — never as a substitute for the server's own check.
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  password_min_length: 8,
  password_max_length: 69,
  password_deny_common: true,
  password_deny_username: true,
  username_min_length: 3,
};
