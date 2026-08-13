# yourphr-ts-spike

**Throwaway.** An experiment to answer one question with evidence instead of argument: *how expensive is a TypeScript/Node FHIR store, really?* Deleting this repo costs nothing and means nothing.

The evaluation it belongs to lives in the product repo: [`docs/planning/typescript-stack-evaluation.md`](https://github.com/jwilleke/yourphr/blob/main/docs/planning/typescript-stack-evaluation.md). **Issues stay in [`jwilleke/yourphr`](https://github.com/jwilleke/yourphr/issues)** — this repo has no tracker of its own, so there is only ever one place to look.

`jwilleke/yourphr` is untouched by any of this. It keeps shipping. If the spike proves out, its history gets merged *into* the product repo rather than the other way round — the issues, planning docs and release lineage are all there and none of them transfer.

## PHI — the one hard rule

Real patient data must never enter git history here, private repo or not. `.gitignore` excludes `/phi/`, `/patient-data/`, `/sample-data/`, `*.ndjson` and `*.db`. Better still, point `--out` at a path entirely outside this repo.

This mirrors the rule in the product repo's `AGENTS.md`: a PHI leak is irreversible.

## What already works

Verified end to end against the **synthetic** seed database (`seed/fasten.seed.db`), so nothing below involved real records:

```
npm install
npm run export -- --db ../yourphr/seed/fasten.seed.db --out phi/seed-resources.ndjson
npm run smoke  -- --in phi/seed-resources.ndjson
```

Result: **72/72 resources loaded, zero rejections**, and searches answered by the library rather than by hand-written per-type columns:

```
Claim?_count=3 -> 3 entries (total 5)
Condition?_count=3 -> 2 entries (total 2)
Encounter?_count=3 -> 3 entries (total 4)
```

That already demonstrates the two claims the evaluation rests on: the existing `resource_raw JSON` column makes export a read rather than a transformation, and search semantics come from `@medplum/fhir-router` rather than from 70 generated model files.

## What is deliberately NOT built yet

`scripts/smoke.ts` uses `MemoryRepository` — the reference implementation shipped by `@medplum/fhir-router`. That isolates "do the resources load and search correctly" from the actual open question:

> **Implement `FhirRepository` over SQLite** (`better-sqlite3-multiple-ciphers`), indexing each resource by evaluating its SearchParameter FHIRPath expressions from `@medplum/definitions` with `fhirpath`.

That is the spike. Everything here exists to make starting it a five-minute job.

## Suggested bar for calling it

Agree this before starting, not after, or the result is a vibe:

1. A SQLite-backed `FhirRepository` passes the same smoke run as `MemoryRepository`, on the real corpus.
2. One clinically meaningful search works end to end — for example `Condition?patient=X&clinical-status=active` — without per-resource-type hand-written columns.
3. An encrypted database written by `better-sqlite3-multiple-ciphers` round-trips. The evaluation flags SQLCipher compatibility with the existing Go-written database as unproven; if that fails, it is a finding, not a blocker to route around quietly.
4. Honest note on what it took, including where Medplum's resource identity model collided with YourPHR's `(source_id, source_resource_type, source_resource_id)` key — expected to be the first real friction.

If (1) and (2) take a weekend, that is the answer. If the FHIR layer eats the whole weekend, that is also the answer.

## Dependencies

| Package | Version | Why |
|---|---|---|
| `@medplum/fhir-router` | 5.1.29 | `FhirRepository` interface + `MemoryRepository`; search, references, history, batch |
| `@medplum/fhirtypes` | 5.1.29 | R4 types — replaces 18.5k generated Go lines |
| `@medplum/definitions` | 5.1.29 | StructureDefinitions + SearchParameters |
| `@medplum/core` | 5.1.29 | Validation and utilities |
| `fhirpath` | 5.1.1 | HL7's FHIRPath engine — drives generic indexing |
| `better-sqlite3-multiple-ciphers` | 13.0.3 | Encrypted SQLite |
