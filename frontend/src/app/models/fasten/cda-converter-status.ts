// Whether this deployment can convert a C-CDA / CCD upload to FHIR, served by
// GET /secure/source/cda-converter/status (#397). C-CDA conversion needs a separate sidecar
// container plus two config settings, so "can the user click Convert" is a server-side fact.
export interface CDAConverterStatus {
  // cda_converter.enabled — the opt-in flag on its own.
  enabled: boolean;
  // Both the flag AND a converter address are present. Only when this is true will an upload
  // actually convert; either setting alone still fails.
  ready: boolean;
  // Operator-facing setup steps (sidecar command + the two YOURPHR_* variables), rendered verbatim
  // when the converter is unavailable so a self-hoster is not left guessing.
  setup_hint: string;
}
