// This deployment's effective SMART on FHIR OAuth relay settings, served by
// GET /secure/source/relay-config (#399). The relay is a deployment concern, so these values come
// from the backend at runtime — they are NOT compiled into the frontend bundle.
export interface RelayConfig {
  // The OAuth redirect_uri this instance uses, i.e. <relay public origin>/callback. This is the
  // value the operator must register with each FHIR vendor; it must match exactly.
  callback_url: string;
  // Whether a relay shared secret is configured. When false, a relay-poll connect cannot complete.
  configured: boolean;
}
