# yourphr-ts-spike

**Throwaway.** An experiment to answer one question with evidence instead of argument: *how expensive is a TypeScript/Node FHIR store, really?* Deleting this repo costs nothing and means nothing.

The evaluation it belongs to lives in the product repo: [`docs/planning/typescript-stack-evaluation.md`](https://github.com/jwilleke/yourphr/blob/main/docs/planning/typescript-stack-evaluation.md). **Issues stay in [`jwilleke/yourphr`](https://github.com/jwilleke/yourphr/issues)** — this repo has no tracker of its own, so there is only ever one place to look.

`jwilleke/yourphr` is untouched by any of this. It keeps shipping. If the spike proves out, its history gets merged *into* the product repo rather than the other way round — the issues, planning docs and release lineage are all there and none of them transfer.

## PHI — the one hard rule

Real patient data must never enter git history here, private repo or not. `.gitignore` excludes `/phi/`, `/patient-data/`, `/sample-data/`, `*.ndjson` and `*.db`. Better still, point `--out` at a path entirely outside this repo.

This mirrors the rule in the product repo's `AGENTS.md`: a PHI leak is irreversible.

## Result: the bar was met

All three criteria below were met against the **synthetic** seed corpus. No real records have been used.

```
npm run export -- --db ../yourphr/seed/fasten.seed.db --out phi/seed-resources.ndjson
npm run load   -- --in phi/seed-resources.ndjson --db phi/spike.db
npm run roundtrip
```

**1. A SQLite-backed `FhirRepository` loads the corpus.** 72/72 resources in ~100ms, 0 id collisions, 1,261 index rows — all derived from FHIR's own SearchParameter definitions, across 59 distinct parameter codes. **551 lines** in `src/SqliteFhirRepository.ts`, and roughly half of that is comment. Compare with 18,518 generated Go lines across 70 files doing the same job.

**2. Clinically meaningful searches work**, with no per-resource-type code anywhere:

```
Condition?patient=Patient/a08...    -> 2  (corpus has 2)
Observation?patient=Patient/a08...  -> 40 (corpus has 40)
Encounter?patient=Patient/a08...    -> 4  (corpus has 4)
Condition?clinical-status=active    -> 1
```

**3. Encryption is real, not assumed** — `npm run roundtrip`, 5/5:

```
PASS  reopen with the correct key
PASS  search works on the encrypted database
PASS  reading WITHOUT the key fails
PASS  reading with the WRONG key fails
PASS  "Wolverine" does not appear in the raw file
```

The last check greps the raw bytes, because "the driver returned rows" is not evidence that what is on disk is ciphertext.

### The finding worth keeping

The first run reported **7 SearchParameter expressions that failed to evaluate**, and the symptom was worse than the error: `Condition?patient=X` returned **0** while `Immunization?patient=X` returned **6**. A search that is confidently wrong, not one that errors.

Cause: FHIR defines reference parameters like `Condition.patient` as `Condition.subject.where(resolve() is Patient)`, and `fhirpath.js` refuses `resolve()` in synchronous mode. `Immunization.patient` is a plain path, so it worked. The fix (`stripResolveGuards`) removes the guard and reinstates it at index time by matching the reference's own type prefix — a reference already knows it is `Patient/123`, so resolving it is unnecessary. Using fhirpath's async mode with a database-backed resolver would have made indexing depend on referential integrity a partially synced PHR does not have.

Same shape as the two defects that started this whole conversation: a silent default, a green-looking result, a wrong answer.

### Still not implemented, deliberately

`withTransaction`, `readHistory`, `readVersion`, `patchResource`, `searchByReference`, `_include`/`_revInclude`, chained and composite parameters. All **throw** rather than return partial answers. Real work for a product; irrelevant to the question this spike asked.

`withTransaction` is the one with a real design question behind it: `better-sqlite3` transactions are synchronous and the interface is async, so it cannot be implemented honestly without either a different driver or a different concurrency story.

## The scripts

| Command | Does |
|---|---|
| `npm run export -- --db <path> [--key <k>]` | Reads `resource_raw` out of any YourPHR SQLite database into NDJSON in `phi/` |
| `npm run smoke -- --in <ndjson>` | Loads it into Medplum's `MemoryRepository` — the control, proving the corpus itself is sound |
| `npm run load -- --in <ndjson> --db <path>` | The real thing: loads through `SqliteFhirRepository`, reports index rows and collisions, runs searches |
| `npm run roundtrip` | Asserts encryption works in both directions, including that the plaintext is absent from the raw file |
| `npm run typecheck` | `tsc --noEmit` |

`smoke.ts` is kept deliberately: when a search disagrees between the two, the difference isolates whether the fault is in this SQLite implementation or in the corpus.

## Run against real records — 2026-08-15

The step the synthetic corpus could not do, now done. Snapshot taken from the live instance with `sqlite3 .backup` (consistent, not a torn copy of a file being written), exported, loaded, and diffed.

| | |
|---|---|
| Resources | **20,061** — 278× the seed corpus |
| Sources | **8** — the multi-source case the identity seam needed |
| Loaded | **20,061 / 20,061**, ~22s |
| Index rows | **417,531**, all from FHIR's own SearchParameter definitions |
| **id collisions** | **0** |
| Differential | **71/71 queries agree** |

**The identity seam did not bite.** That was the open question this run existed to answer: YourPHR keys on `(source_id, source_resource_type, source_resource_id)` because one record can arrive from several providers, while Medplum keys on `ResourceType/id`. Across 8 sources and 20,061 resources, **zero collisions**. Not proof it can never happen — a ninth source could still send a colliding id — but the concern was hypothetical and now has a number against it.

Resource types the spike had never seen loaded without special-casing, which is the whole point of a generic indexer: `NutritionOrder`, `DeviceRequest`, `AdverseEvent`, `FamilyMemberHistory`, `RelatedPerson`, `Composition`, `Specimen`, `Media`, `Goal`.

### A flaw in the harness, found by real data

The first real run reported **3 disagreements** on `Condition` and `DocumentReference`. Both sides returned exactly **1000** results — a *different* 1000. Neither repository promises an order beyond a page, and the corpus holds 3,469 Conditions and 15,225 DocumentReferences, so the harness was comparing two arbitrary slices and calling the difference a defect.

That was the harness being wrong, and it is exactly the false alarm that teaches people to ignore a gate. Where a result exceeds one page the totals are now compared instead, and the output says so rather than implying membership was checked.

Worth noting the synthetic corpus could never have surfaced this: nothing in it comes close to 1000 of anything.

## Shadow read-only against the production stack — 2026-08-15

The migration plan's first step: run both stacks over one corpus and diff the responses, before anything owns a surface.

The `diff` script above compares against Medplum's reference. **This compares against the system actually in production**, which is the harder test — the reference and this spike share a worldview, YourPHR's Go backend does not.

```bash
# in the product repo — reads through GormRepository, the same path the HTTP handler uses,
# so no session and no credentials, against a COPY of a snapshot
SHADOW_DB=<copy> SHADOW_USER=<account> SHADOW_OUT=phi/go-ids.json \
  go test ./backend/pkg/database/ -run TestShadowExport

# here
npm run export -- --db <copy> --user <account> --out phi/account.ndjson
npm run load   -- --in phi/account.ndjson --db phi/shadow-spike.db
npm run shadow -- --go phi/go-ids.json    --db phi/shadow-spike.db
```

Result on one real account — **19,796 resources, 29 resource types**:

```text
29/29 resource types agree exactly

the TypeScript stack returns exactly what the Go stack returns
```

Every type matched id-for-id, including the large ones: 15,225 DocumentReference, 3,456 Condition, 354 Encounter.

**Comparisons must be per-account.** The Go API enforces per-user isolation from the request context, so an unscoped export cannot be compared against it — the first attempt had 20,061 resources on one side and 19,796 on the other, because a second account's records were in the corpus. `--user` was added to the export for this.

## Write-path testing against real records — 2026-08-16

Everything above is read-path. A store that answers correctly but corrupts on the second import, or leaves stale index rows after an update, is worse than useless for a PHR: records arrive repeatedly, from providers that resend the same resource with small changes.

```bash
npm run writes -- --in phi/account.ndjson
```

**11/11 checks pass** on 19,796 real resources:

| Area | Checked |
|---|---|
| Re-import | the same corpus imported twice creates no duplicates; all 19,796 are recognised as already present |
| Update | visible on read, no second copy, **the old indexed value stops matching**, the new one starts |
| Delete | gone from search, unreadable, and its index rows are removed |
| Reindex | rebuilding every index row from stored content reproduces the same index, and search still answers |

The update case is the one that matters. If old index rows survive an update, a resolved condition keeps answering a search for active ones — the record looks right when opened and wrong in every list, which is the hardest kind of wrong to notice.

**Verified to have teeth.** Removing the `DELETE FROM search_index` that precedes reindexing turns it red exactly there:

```text
FAIL  the OLD indexed value no longer matches after an update — stale index row survived
FAIL  a full reindex reproduces the same index — 407255 -> 407252
9/11 checks passed
```

Re-import is the direct analogue of [#252](https://github.com/jwilleke/yourphr/issues/252) in the product repo — harden re-import dedup against stale overwrites.

## What this still does NOT prove

- **No SYNC, no auth, no HTTP layer.** Writes and dedup are now covered (above), but nothing here fetches from a provider, authenticates anybody, or serves a request. Tracked as a P1 in the product repo.
- **The existing encrypted database has not been opened.** Round-tripping a database this code wrote is not the same as reading one SQLCipher-via-Go wrote. That remains the open compatibility question — though the live instance turns out to be **unencrypted**, so it is less pressing than it looked.
- **Read paths only.** Every number above is about getting data in and querying it back.
- **~22s to load 20k resources** is not a benchmark. Nothing here is tuned, and no comparison against the Go implementation was made.

## If it goes further

Ordering, from the evaluation doc: read before write, reversible before irreversible, and never a moment where the records live only in the unproven store.

1. Same load against a **real export**, with the collision count taken seriously.
2. Shadow read-only against the live API — same queries to both stacks, diff the responses.
3. Only then writes, and auth last, because auth failures are the ones that pass tests while being wrong.

## Dependencies

| Package | Version | Why |
|---|---|---|
| `@medplum/fhir-router` | 5.1.29 | `FhirRepository` interface + `MemoryRepository`; search, references, history, batch |
| `@medplum/fhirtypes` | 5.1.29 | R4 types — replaces 18.5k generated Go lines |
| `@medplum/definitions` | 5.1.29 | StructureDefinitions + SearchParameters |
| `@medplum/core` | 5.1.29 | Validation and utilities |
| `fhirpath` | 5.1.1 | HL7's FHIRPath engine — drives generic indexing |
| `better-sqlite3-multiple-ciphers` | 13.0.3 | Encrypted SQLite |
