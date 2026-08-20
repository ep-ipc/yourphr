/**
 * Source + token migration from the Go stack (yourphr#584; Phase 5 rung two).
 *
 * A finding that simplified this issue: Go's tokens are NOT encrypted at the column level —
 * config.Secret redacts logs and JSON, while GORM's Valuer persists the real value, and the
 * production database runs unencrypted (the at-rest story was the #545/#461 thread). So the
 * export is a direct read of source_credentials; the protection this migration owes the tokens
 * is the spike's own at-rest encryption on the RECEIVING side, not a decrypt step.
 *
 * Two derivations, both honest:
 *   - Go stores no token endpoint (it re-discovers from smart-configuration every time). The
 *     import stores tokenUrl = '' and the WORKER discovers-and-persists on first need — so the
 *     import itself needs no network and a migrated source needs no reconnect.
 *   - Resource types come from the SMART scopes the patient actually granted:
 *     patient/<Type>.read|.rs -> that type; patient/*.read -> the core set. Deriving from the
 *     grant means the worker asks for exactly what the source authorized, nothing more.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import type { SourceStore } from '../worker/index.js';

/** The core set a wildcard grant maps to — the types the record screens actually use. */
export const WILDCARD_RESOURCE_TYPES = [
  'Patient', 'AllergyIntolerance', 'Condition', 'Encounter', 'Immunization',
  'MedicationRequest', 'MedicationStatement', 'Observation', 'Procedure', 'DiagnosticReport', 'DocumentReference',
];

export function resourceTypesFromScopes(scopes: string): string[] {
  const types = new Set<string>();
  let wildcard = false;
  for (const scope of scopes.split(/\s+/)) {
    const m = scope.match(/^patient\/([A-Za-z]+|\*)\.(read|rs|r)$/);
    if (!m) continue;
    if (m[1] === '*') {
      wildcard = true;
    } else {
      types.add(m[1] as string);
    }
  }
  if (wildcard) {
    for (const t of WILDCARD_RESOURCE_TYPES) types.add(t);
  }
  return [...types];
}

export interface LegacySource {
  username: string;
  display: string;
  fhirBaseUrl: string;
  clientId: string;
  patient: string;
  scopes: string;
  accessToken: string;
  refreshToken: string;
  /** unix seconds, 0 when Go never recorded one (treated as expired -> first pass refreshes). */
  expiresAt: number;
  environment: string;
}

/**
 * Reads source_credentials from a Go database file, joining users for the username the spike
 * keys on. Soft-deleted rows (either table) are skipped — a disconnected source stays
 * disconnected.
 */
export function readGoSources(goDb: InstanceType<typeof Database>): LegacySource[] {
  const rows = goDb
    .prepare(
      `SELECT u.username AS username, s.display AS display, s.api_endpoint_base_url AS base,
              COALESCE(s.client_id, '') AS client_id, COALESCE(s.patient, '') AS patient,
              COALESCE(s.scopes, '') AS scopes, COALESCE(s.access_token, '') AS access_token,
              COALESCE(s.refresh_token, '') AS refresh_token, COALESCE(s.expires_at, 0) AS expires_at,
              COALESCE(s.environment, 'production') AS environment
       FROM source_credentials s JOIN users u ON u.id = s.user_id
       WHERE s.deleted_at IS NULL AND u.deleted_at IS NULL`
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    username: String(r['username']),
    display: String(r['display']),
    fhirBaseUrl: String(r['base']),
    clientId: String(r['client_id']),
    patient: String(r['patient']),
    scopes: String(r['scopes']),
    accessToken: String(r['access_token']),
    refreshToken: String(r['refresh_token']),
    expiresAt: Number(r['expires_at']),
    environment: String(r['environment']),
  }));
}

export interface SourceImportReport {
  imported: string[];
  skippedExisting: string[];
  /** Sources with no refresh token — they migrate, but the first expiry needs a reconnect. */
  needsReconnect: string[];
}

/**
 * One-way import into the spike's SourceStore: an existing (user, base, patient) source is
 * skipped and reported, never overwritten. tokenUrl lands '' — the worker discovers it on first
 * need. Tokens land verbatim; expiry carries so a still-valid access token keeps working and an
 * expired one refreshes on the first pass.
 */
export function importLegacySources(store: SourceStore, sources: LegacySource[]): SourceImportReport {
  const report: SourceImportReport = { imported: [], skippedExisting: [], needsReconnect: [] };
  const existing = new Set(store.list().map((s) => `${s.userId}|${s.fhirBaseUrl}|${s.patient}`));
  for (const source of sources) {
    const key = `${source.username}|${source.fhirBaseUrl}|${source.patient}`;
    const label = `${source.username}:${source.display}`;
    if (existing.has(key)) {
      report.skippedExisting.push(label);
      continue;
    }
    existing.add(key);
    store.add({
      userId: source.username,
      display: source.display,
      fhirBaseUrl: source.fhirBaseUrl,
      tokenUrl: '', // discovered by the worker on first need — the import stays offline
      clientId: source.clientId,
      patient: source.patient,
      resourceTypes: resourceTypesFromScopes(source.scopes),
      accessToken: source.accessToken,
      refreshToken: source.refreshToken,
      expiresAt: source.expiresAt,
    });
    report.imported.push(label);
    if (source.refreshToken === '') {
      report.needsReconnect.push(label);
    }
  }
  return report;
}
