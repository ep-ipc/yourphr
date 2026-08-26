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
/*
 * provenanceFor() used to live here as a free function over a store handle. The Records manager
 * computes provenance now (yourphr#609) — a view computed past the door was a second door.
 */
/** The one-line legible rendering — what a record card's provenance row shows. */
export function legibleProvenance(p) {
    const first = p.firstReceivedAt.slice(0, 10);
    const last = p.lastConfirmedAt.slice(0, 10);
    const base = `From ${p.sourceDisplay} · first received ${first}`;
    return first === last && p.timesSeen === 1 ? base : `${base} · last confirmed ${last} · seen ${p.timesSeen} times`;
}
//# sourceMappingURL=index.js.map