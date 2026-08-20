/**
 * Provenance (yourphr#579; Phase 4 of yourphr#542) — which source said what, when, per record.
 *
 * The storage layer already carries the facts: every row is keyed with the source_id that wrote it
 * (yourphr#539's cross-source collision refusal depends on exactly that), every write is versioned
 * into resource_history with its timestamp. This module is the SURFACE: one queryable, patient-
 * legible answer per record —
 *
 *   "From <source> · first received <date> · last confirmed <date> · seen <n> times"
 *
 * Framing note: the sync path rewrites every record it receives, so a version in history means
 * "the source presented this record again", not "the record changed". first/last/count says that
 * honestly. (Skipping versions for byte-identical content is yourphr#252's question, not this
 * module's.)
 *
 * No guessing: a record with no recorded source says so ("this instance", covering manual entry
 * and uploads) rather than inventing an origin.
 */
import type Database from 'better-sqlite3-multiple-ciphers';

export interface RecordProvenance {
  resourceType: string;
  id: string;
  /** The raw source attribution ('' = written by this instance: manual entry or upload). */
  sourceId: string;
  /** Legible name for the source — resolver-supplied, or the honest fallback. */
  sourceDisplay: string;
  /** Earliest version timestamp — when this instance first received the record. */
  firstReceivedAt: string;
  /** Current version timestamp — when the source last presented it. */
  lastConfirmedAt: string;
  /** How many times the record has been presented (history rows). */
  timesSeen: number;
}

export interface ProvenanceDeps {
  db: InstanceType<typeof Database>;
  userId: string;
  /** Maps a source_id to its display name; return '' when unknown — never invent. */
  sourceDisplay?: (sourceId: string) => string;
}

export function provenanceFor(deps: ProvenanceDeps, resourceType: string, id: string): RecordProvenance | undefined {
  const row = deps.db
    .prepare('SELECT source_id, last_updated FROM resources WHERE resource_type = ? AND id = ? AND user_id = ? AND deleted = 0')
    .get(resourceType, id, deps.userId) as { source_id: string; last_updated: string } | undefined;
  if (!row) {
    return undefined;
  }
  const history = deps.db
    .prepare('SELECT MIN(last_updated) AS first, COUNT(*) AS n FROM resource_history WHERE resource_type = ? AND id = ?')
    .get(resourceType, id) as { first: string | null; n: number };

  const display = row.source_id === ''
    ? 'This instance (manual entry or upload)'
    : (deps.sourceDisplay?.(row.source_id) ?? '') || row.source_id; // fall back to the raw id, never a guess

  return {
    resourceType,
    id,
    sourceId: row.source_id,
    sourceDisplay: display,
    firstReceivedAt: history.first ?? row.last_updated,
    lastConfirmedAt: row.last_updated,
    timesSeen: Math.max(history.n, 1),
  };
}

/** The one-line legible rendering — what a record card's provenance row shows. */
export function legibleProvenance(p: RecordProvenance): string {
  const first = p.firstReceivedAt.slice(0, 10);
  const last = p.lastConfirmedAt.slice(0, 10);
  const base = `From ${p.sourceDisplay} · first received ${first}`;
  return first === last && p.timesSeen === 1 ? base : `${base} · last confirmed ${last} · seen ${p.timesSeen} times`;
}
