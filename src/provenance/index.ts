/**
 * Provenance (yourphr#579; Phase 4 of yourphr#542) — which source said what, when, per record.
 *
 * The storage layer already carries the facts: every row is keyed with the source_id that wrote it
 * (yourphr#539's cross-source collision refusal depends on exactly that), every CHANGE is versioned
 * into resource_history with its timestamp, and the row's last_updated moves each time the source
 * presents the record again. This module is the SURFACE: one queryable, patient-legible answer per
 * record —
 *
 *   "From <source> · first received <date> · last confirmed <date> · changed <n> times"
 *
 * Since yourphr#781 a version means "the record changed". A re-sync that brings back an identical
 * record writes no version; it only moves "last confirmed". The line used to say "seen <n> times",
 * a count of sync passes that reached the thousands and told a patient nothing (decided by Jim,
 * 2026-09-26).
 *
 * No guessing: a record with no recorded source says so ("this instance", covering manual entry
 * and uploads) rather than inventing an origin.
 */

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
  /** Distinct versions stored (history rows); 1 means it has never changed since it arrived. */
  versions: number;
}

/*
 * provenanceFor() used to live here as a free function over a store handle. The Records manager
 * computes provenance now (yourphr#609) — a view computed past the door was a second door.
 */

/** The one-line legible rendering — what a record card's provenance row shows. */
export function legibleProvenance(p: RecordProvenance): string {
  const first = p.firstReceivedAt.slice(0, 10);
  const last = p.lastConfirmedAt.slice(0, 10);
  const changes = Math.max(p.versions - 1, 0);
  return [
    `From ${p.sourceDisplay} · first received ${first}`,
    ...(last !== first ? [`last confirmed ${last}`] : []),
    ...(changes > 0 ? [`changed ${changes} ${changes === 1 ? 'time' : 'times'}`] : []),
  ].join(' · ');
}
