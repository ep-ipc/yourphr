/**
 * Keep configured secrets out of log output (yourphr#638, yourphr#682).
 *
 * Ported from ngdpbase's `src/utils/redactSecrets.ts` (its #1030), which exists because of the
 * hole this stack has: `yourphr.config.secret-keys` already names the values that must never be
 * shown, and it drives masking on Admin → Configuration — but nothing applied that list to the
 * logs. A secret reaching a log line was written in the clear to stdout, to the container log, and
 * into the ring buffer that `GET /api/secure/admin/logs` serves to anyone with `admin-read`.
 *
 * This is defence in depth, NOT permission to log secrets. It matches literal occurrences only: a
 * value that has been base64-encoded, URL-embedded, hashed or paraphrased still gets through. The
 * rule stays "do not log credentials"; this catches the mistakes.
 *
 * ## Why the values are pushed in rather than read
 *
 * `src/log/index.ts` imports nothing, on purpose — it is imported by nearly everything, including
 * ConfigurationManager. Reading configuration from here would invert that and create a bootstrap
 * cycle. So the table is module-level, starts EMPTY, and is filled by
 * {@link refreshRedactedSecrets} once configuration is resolved.
 *
 * Two consequences worth knowing:
 *
 *   - Lines emitted before that call are not redacted. Nothing has read configuration at that
 *     point, so a configuration-derived secret cannot be in them.
 *   - {@link redact} reads the live table on every call, which is what makes the deferred fill
 *     work at all.
 *
 * ## Where this diverges from ngdpbase, and why
 *
 * ngdpbase installs a winston format ahead of `printf`. This logger has no format pipeline, so
 * redaction is applied at the single choke point in `AppLog.log()` instead. That placement matters
 * for a reason ngdpbase does not have: the line is redacted BEFORE it enters the ring buffer, so
 * the copy the Logs page serves is redacted too. Redacting only on the way to stdout would leave
 * the plaintext sitting in memory behind an `admin-read` route — which is the surface yourphr#638
 * is actually about.
 */

/** The configuration key naming which other keys hold secrets. */
const SECRET_KEYS_KEY = 'yourphr.config.secret-keys';

/**
 * Values shorter than this are never redacted.
 *
 * A short secret corrupts every line containing it as a substring: were a password set to `admin`,
 * redaction would mangle the word "admin" across unrelated output and make the logs useless —
 * while teaching nobody that the password is weak. Skipping is reported, not silent.
 */
const MIN_SECRET_LENGTH = 8;

interface Redaction {
  /** The configuration key the value came from — named in the replacement marker. */
  key: string;
  /** The literal value to strike from log output. */
  value: string;
}

/** Why a listed key contributed no redaction. */
export interface SkippedSecret {
  key: string;
  reason: 'unset' | 'empty' | 'env-ref' | 'too-short';
}

export interface RefreshResult {
  /** How many values are now being redacted. */
  active: number;
  /** Listed keys that contributed nothing, with the reason. */
  skipped: SkippedSecret[];
}

/**
 * Active redactions, longest value first.
 *
 * Rebuilt only by {@link refreshRedactedSecrets}, never per line. Every log line pays one pass per
 * entry, so this is a hot path and the list stays short by construction — it is the secret-keys
 * list, which is deliberately brief.
 */
let redactions: Redaction[] = [];

/**
 * The minimum shape needed from ConfigurationManager, declared here rather than imported — that
 * import is the bootstrap cycle this module exists on the far side of.
 */
export interface SecretConfigReader {
  getStringList(key: string): string[];
  getString(key: string): string;
}

/** Classify a resolved value, or return null when it is usable. */
function rejectionReason(value: string | undefined): SkippedSecret['reason'] | null {
  if (value === undefined) return 'unset';
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  // A value still starting with `$` did not resolve — it is a pointer to an unset variable, not a
  // secret. Redacting the literal would strike the documentation that explains the convention.
  if (trimmed.startsWith('$')) return 'env-ref';
  if (trimmed.length < MIN_SECRET_LENGTH) return 'too-short';
  return null;
}

/**
 * Rebuild the redaction table from the current configuration.
 *
 * Call once configuration is resolved, and again after any change to the secret keys or their
 * values. Safe to call repeatedly — it replaces the table wholesale rather than accumulating.
 *
 * @returns what is now active, and which listed keys were skipped and why. The caller logs the
 * skips: this module never imports the logger, for the cycle reason above.
 */
export function refreshRedactedSecrets(config: SecretConfigReader | null | undefined): RefreshResult {
  const skipped: SkippedSecret[] = [];
  if (!config || typeof config.getStringList !== 'function') {
    redactions = [];
    return { active: 0, skipped };
  }

  let keys: string[];
  try {
    keys = config.getStringList(SECRET_KEYS_KEY);
  } catch {
    redactions = [];
    return { active: 0, skipped };
  }

  const seen = new Set<string>();
  const next: Redaction[] = [];
  for (const rawKey of keys) {
    if (typeof rawKey !== 'string') continue;
    const key = rawKey.trim();
    if (key === '') continue;

    let value: string | undefined;
    try {
      value = config.getString(key);
    } catch {
      value = undefined; // an unknown key is a stale secret-keys entry, not a crash
    }
    const reason = rejectionReason(value);
    if (reason) {
      skipped.push({ key, reason });
      continue;
    }

    const literal = (value as string).trim();
    // Two keys holding the same value redact once; the first key names it.
    if (seen.has(literal)) continue;
    seen.add(literal);
    next.push({ key, value: literal });
  }

  // Longest first: where one secret contains another, the longer must be struck first or the
  // shorter leaves a mangled remainder of the longer.
  next.sort((a, b) => b.value.length - a.value.length);
  redactions = next;
  return { active: redactions.length, skipped };
}

/** Drop all redactions. Intended for tests. */
export function clearRedactedSecrets(): void {
  redactions = [];
}

/** How many values are currently redacted. Intended for tests and diagnostics. */
export function redactedSecretCount(): number {
  return redactions.length;
}

/**
 * Replace every configured secret in `text` with `[redacted:<key>]`.
 *
 * The key is named so the line stays diagnosable — "the database key appeared here" is useful; an
 * anonymous `••••` is not.
 *
 * split/join rather than a RegExp: secrets routinely contain regex metacharacters, and building a
 * pattern out of one is how a redactor comes to throw on the single line that mattered.
 */
export function redact(text: string): string {
  if (redactions.length === 0 || typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const { key, value } of redactions) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${key}]`);
  }
  return out;
}
