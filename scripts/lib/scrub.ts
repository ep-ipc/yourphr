/**
 * Keep credentials out of harness output (yourphr#682).
 *
 * The app's own logger redacts by CONFIGURATION — `src/log/redact.ts` reads
 * `yourphr.config.secret-keys` and strikes those literal values, which is ngdpbase's design
 * (its #1030). A harness has no configuration to consult: the values worth hiding are the session
 * tokens it just minted against a throwaway instance, and they are different on every run.
 *
 * So this is the same principle with the other source of truth — SHAPE rather than a list. It is
 * the weaker of the two by construction, and it is used in the weaker place: harness output goes
 * to a CI log, not to `/api/secure/admin/logs`.
 *
 * Why it is worth having at all, given the alert that prompted it was a false positive: the
 * `check(name, ok, detail)` helper is copied into 27 harnesses, and `detail` is free text that any
 * future check can fill with a whole response body. CodeQL flagged the one call site where only
 * status integers are interpolated; it is right about the shape of the risk and wrong about that
 * line. Scrubbing at the reporter fixes the shape once, for every harness including the ones not
 * written yet.
 *
 * NOT permission to print credentials. This catches mistakes; it does not license them.
 */

/**
 * Patterns for things that are a credential whatever they are called.
 *
 * Deliberately narrow. A greedy pattern that ate any long random-looking string would mangle
 * record ids, hashes and FHIR identifiers — the harnesses assert on those constantly, and a
 * reporter that corrupts the evidence is worse than one that prints too much.
 */
const PATTERNS: { re: RegExp; label: string }[] = [
  // A JWT: three base64url segments. The most common thing a harness holds.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: 'jwt' },
  // `Bearer <anything>` in a header echo.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, label: 'bearer' },
  // The session cookie, by name, with whatever follows it.
  { re: /\byourphr_session=[^;\s"']+/g, label: 'session-cookie' },
  // Named credential fields in an interpolated JSON body.
  { re: /"(password|token|access_token|refresh_token|code_verifier|client_secret)"\s*:\s*"[^"]*"/g, label: 'credential-field' },
];

/** Replace anything credential-shaped in `text` with `[redacted:<what>]`. */
export function scrub(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const { re, label } of PATTERNS) out = out.replace(re, `[redacted:${label}]`);
  return out;
}

/**
 * The reporter every harness shares.
 *
 * Returns its own results array so a harness keeps the `results`/`check` pair it already has,
 * rather than reaching for a module-level singleton that two harnesses in one process would share.
 */
export function reporter(): {
  results: { name: string; ok: boolean; detail: string }[];
  check: (name: string, ok: boolean, detail?: string) => void;
} {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = ''): void => {
    const safe = scrub(detail);
    results.push({ name, ok, detail: safe });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${safe ? ` — ${safe}` : ''}`);
  };
  return { results, check };
}
