# TypeScript stack evaluation — planning

> **Status: planning, not decided.** Nothing here is built and nothing is committed to. This records the landscape, the measured costs, and the questions still open, so the argument does not have to be reconstructed from memory next time. Started 2026-08-13.

## Scope

**Runtime and stack only** — whether YourPHR's backend stays Go or moves to TypeScript/Node, and what open-source FHIR work already exists in that ecosystem to adopt rather than rebuild.

**Explicitly out of scope: the rendering model.** Whether the admin surfaces should be server-rendered rather than an SPA is a separate decision, argued in [`authorization-framework.md`](authorization-framework.md), and it can be taken independently and later. Conflating the two makes both harder.

**Explicitly out of scope: the delivery unit.** Container for self-hosters, desktop app, or hosted service — that question constrains the design more than the language does, and it is unresolved. Noted in the open questions below.

## What prompted this

Three defects on 2026-08-13: two in [#527](https://github.com/jwilleke/yourphr/issues/527), one in [#528](https://github.com/jwilleke/yourphr/issues/528). Two of the three were in the Angular half, one in the Go half. All three were the same shape — a framework's silent default disagreeing with what the code assumed, with a green test suite on top because the test wired the subject differently from production.

So the language was not the variable in the day's failures. But a second argument is stronger and is not about defect rates: **for a single maintainer, fluency is an architecture constraint, not a preference.** A stack the maintainer thinks slowly in produces worse designs, not merely slower ones. Fasten chose Go for a centralized multi-tenant product; that reasoning does not transfer to a family-scale PHR maintained by one person who is fastest in TypeScript.

## Where we are today — measured

| Measure | Value |
|---|---|
| Backend Go, non-test | 47,661 lines |
| — of which generated FHIR models | 18,518 lines across 70 files in `backend/pkg/models/database/` (39%) |
| Frontend TypeScript / HTML / SCSS | 76,776 lines |
| Migrations | 24, in `backend/pkg/database/gorm_repository_migrations.go` |
| ngdpbase, non-test TypeScript | 101,515 lines, 40 managers |

Coupling to upstream Fasten is already largely broken:

- `fasten-sources` was made private, so `go.mod` carries `replace github.com/fastenhealth/fasten-sources => ./fasten-sources-stub`.
- The C-CDA converter is **Metriport — already an external TypeScript service**, built by `.github/workflows/docker-cda-converter.yaml`.
- Database encryption depends entirely on a pinned fork: `replace github.com/mattn/go-sqlite3 => github.com/jgiannuzzi/go-sqlite3 v1.14.17-...` for SQLCipher DSN pragmas.
- [#278](https://github.com/jwilleke/yourphr/issues/278) (rename Fasten* → YourPHR) is deferred pending a decision to commit to a hard fork. Much of that fork has already happened in practice.

## The two findings that matter most

### 1. The data is already portable

Every resource table carries **`resource_raw JSON`** holding the canonical FHIR resource whole, alongside extracted columns. Verified against `seed/fasten.seed.db`:

```sql
CREATE TABLE `fhir_condition` (`id` uuid, ..., `resource_raw` JSON, `abatementAge` JSON, `abatementDate` datetime, `clinicalStatus` JSON, `onsetDate` datetime, `severity` JSON, ...);
```

So a migration is a **dump and re-index**, not a transformation. Read `resource_raw` out, hand it to a new implementation, let that implementation build its own indexes. Nothing lossy, no schema archaeology — and both stacks can be run against the same exported corpus and their results diffed. This removes the largest risk normally attached to a rewrite of a data-holding product.

### 2. A generic indexer replaces the 70 generated models

Those 18.5k generated lines exist to produce **one column per search parameter, per resource type**. That is the search index, hand-generated.

In TypeScript the same job is done generically: take each SearchParameter definition from `@medplum/definitions`, evaluate its FHIRPath expression with `fhirpath`, write the result to a generic index table. **One indexer replaces 70 generated model files.**

This is the strongest *technical* argument for the move, and it is worth separating from the fluency argument: it is not a translation of the same design into another language, it is a simpler design that the TypeScript ecosystem makes available.

## FOSS adoption map

Versions and licenses verified 2026-08-13 against the npm registry.

| Package | Version | License | Covers | Does not cover |
|---|---|---|---|---|
| `@medplum/fhir-router` | 5.1.29 | Apache-2.0 | Abstract `FhirRepository` + working `MemoryRepository`; URL routing, search-parameter matching (`matchesSearchRequest`), reference resolution, history/versioning, JSONPatch, batch/transaction, GraphQL | Storage. You implement one interface over SQLite |
| `@medplum/fhirtypes` | 5.1.x | Apache-2.0 | R4 TypeScript types — the replacement for the 18.5k generated Go lines | — |
| `@medplum/definitions` | 5.1.x | Apache-2.0 | StructureDefinitions and SearchParameters | — |
| `@medplum/core` | 5.1.x | Apache-2.0 | Validation, client, utilities; usable standalone against any FHIR server | — |
| [`fhirpath`](https://github.com/HL7/fhirpath.js) | 5.1.1 | HL7 | FHIRPath evaluation — HL7's own implementation | — |
| [`fhirclient`](https://github.com/smart-on-fhir/client-js) | 2.6.3 | Apache-2.0 | SMART launch and token flow, browser and Node | Provider catalog, brand/portal/endpoint model, registration |
| [`better-sqlite3-multiple-ciphers`](https://github.com/m4heshd/better-sqlite3-multiple-ciphers) | 13.0.3 | MIT | Encrypted SQLite — the answer to the SQLCipher objection | Note the documented caveat on legacy-SQLCipher database compatibility; migrating an existing encrypted database needs proving |

The significant point: **the expensive part of a FHIR server — search semantics — is off the shelf and Apache-2.0.** The remaining work is a `FhirRepository` implementation over SQLite.

## What stays hand-written regardless of language

- **Provider catalog, SMART connect, DCR** ([#355](https://github.com/jwilleke/yourphr/issues/355)) — `fhirclient` does the launch dance; nothing does the catalog, the brand/portal/endpoint model, or dynamic registration.
- **Sync jobs and re-import dedup** ([#252](https://github.com/jwilleke/yourphr/issues/252)).
- **Config manager, backup/restore, bootstrap provisioning** — recent work, ported rather than rethought.
- **Patient-legible display** ([#262](https://github.com/jwilleke/yourphr/issues/262)) — the actual product, and already TypeScript.

## `jwilleke/ngdpbase` as prior art and possible source

Measured: 101.5k non-test TypeScript lines, 40 managers, a provider architecture with pluggable authentication (`PasswordAuthProvider`, `MagicLinkAuthProvider`, `AuthentikBearerAuthProvider`, `CloudflareAccessAuthProvider`, `AgentTokenAuthProvider`), `ACLManager` at 1,137 lines driven by a `PolicyEvaluator` over allow/deny `AccessPolicy` objects, and — directly relevant to the audit thread on [#507](https://github.com/jwilleke/yourphr/issues/507) — `DatabaseAuditProvider`, `FileAuditProvider` and `CloudAuditProvider` already exist.

Two caveats worth recording before anyone plans around them:

- **`src/plugins/` are JSPWiki-style markup macros, not app modules.** "YourPHR as an ngdpbase plugin" is not the shape that is actually available. Reuse would be of the managers and providers.
- **The ACL is page-oriented.** Medical records need resource and compartment rules, which is what Medplum's declarative Access Policies are built for.

Three reuse shapes, none chosen:

1. **Copy the managers** into YourPHR and adapt for resource-level rules. No coupling; two copies to maintain.
2. **Extract a shared package** both products consume. Best long-term if both keep running; largest up-front refactor of ngdpbase, and couples release cycles.
3. **Medplum AccessPolicy for records, ngdpbase ideas for roles and UI gating.** Least new code; adopts someone else's model for the part that governs medical data.

## What this does not force

**A backend rewrite does not force a frontend rewrite.** The Angular app talks to an HTTP contract that a TypeScript backend can serve unchanged, leaving 76.8k lines in place. Server-rendering — the thing that would actually remove the authorization-projection problem described in [`authorization-framework.md`](authorization-framework.md) — is a separate decision that could be taken later, incrementally, or never.

## Costs and risks that remain

- **Time.** Even with the FHIR domain adopted rather than built, this is months of evenings, during which the live instance keeps needing fixes ([#528](https://github.com/jwilleke/yourphr/issues/528) did not wait).
- **Re-earned knowledge.** Line count is not the cost; understanding search parameters, reference graphs and re-import dedup is. Adoption reduces this but does not remove it.
- **Encrypted-database migration.** The existing SQLCipher database must be provably readable by whatever replaces it, before anything switches.
- **No upstream, ever again.** Already nearly true, but a rewrite makes it final.

## Open questions

1. **Resource identity.** YourPHR keys on `(source_id, source_resource_type, source_resource_id)` because one record can arrive from three providers; FHIR's `id` is single-server. Where does that seam land against Medplum's model? Expected to be the first real friction.
2. **Is `PolicyEvaluator`'s shape reusable** when the subject is a resource compartment rather than a wiki page?
3. **What is the delivery unit** — self-hoster's container, desktop app, or hosted service? It constrains the stack more than the language does, and today's k3s + Flux + GHCR pipeline implies an audience of one.
4. **What is the smallest experiment that would settle this**, run against real records rather than argued? A candidate: export the live records, implement `FhirRepository` over `better-sqlite3-multiple-ciphers`, index via `@medplum/definitions` + `fhirpath`, and render one condition list correctly — with the success criteria agreed before starting.
5. **Does the release-gated deploy loop change independently of all this?** It was the largest time cost in the session that prompted the question, and it is neither a language nor a rendering problem.
