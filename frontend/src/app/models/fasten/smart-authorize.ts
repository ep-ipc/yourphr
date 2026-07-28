// Payloads for POST /secure/source/authorize — the backend performs SMART on FHIR discovery and
// builds the PKCE authorize URL. The browser opens authorize_url and never handles tokens.
// EPIC #20, issue #52.
export interface SmartAuthorizeRequest {
  api_endpoint_base_url: string;
  client_id: string;
  scopes: string;
  // Optional — the backend derives it from this deployment's relay config (relay.public_url /
  // YOURPHR_RELAY_PUBLIC_URL) so a self-hosted relay needs no frontend rebuild (#399). Only send
  // one to override the instance default.
  redirect_uri?: string;
}

export interface SmartAuthorizeResponse {
  authorize_url: string;
  state: string;
  code_verifier: string;
  // The redirect_uri the backend actually used. Round-trip it verbatim to the connect call — the
  // token exchange requires an exact match.
  redirect_uri?: string;
  // How long (seconds) the client should keep polling for the auth code while the user logs in at
  // the provider. Operator-tunable backend config (web.smart_connect.login_wait_seconds) so it can
  // change without a frontend rebuild; optional — the client falls back to its own default if absent.
  login_wait_seconds?: number;
}
