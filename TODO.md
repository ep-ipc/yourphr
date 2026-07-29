# TODO

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider (C-CDA import not enabled) — two fixes released (v1.13.3 discoverability, v1.13.4 the Docker `.env` passthrough that was the actual blocker); see In review.
- **12 open Dependabot alerts, untracked by any issue** (7 high, 5 medium) — all in `frontend/yarn.lock`; `go.mod` is clean. **No Dependabot PR covers any of them**, so the 2026-07-28 decision to "clear these by merging PRs rather than filing issues" has run out of road — the merge queue is drained and these are what remains. Either bridge them into issues or determine why Dependabot will not open PRs (several are deep transitives, and `postcss` is held by a `resolutions` pin in `frontend/package.json`).
  - `brace-expansion` x3, `js-yaml` x3, `webpack-dev-server` x2, `engine.io`, `picomatch`, `postcss`, `@hono/node-server`
  - All are build/dev-chain transitives that do not ship in the served image — exposure is a developer machine, not patient data. Partially tracked by [#345](https://github.com/jwilleke/yourphr/issues/345) (the `webpack-dev-server` / `http-proxy-middleware` tree).
- 0 open code-scanning alerts.

## 🟠 P1

- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)

## 🟡 P2

- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
- [#14](https://github.com/jwilleke/yourphr/issues/14) — [FEATURE] User Profile Update
- [#20](https://github.com/jwilleke/yourphr/issues/20) — [EPIC] SMART on FHIR — live provider sync
- [#53](https://github.com/jwilleke/yourphr/issues/53) — [SMART] Veradigm/FollowMyHealth registration + end-to-end integration
- [#244](https://github.com/jwilleke/yourphr/issues/244) — [EPIC] Per-profile dashboard widgets (US Core display end-state)
- [#251](https://github.com/jwilleke/yourphr/issues/251) — [FEATURE] Explore Apple Health's supported-institution list as a provider-catalog / FHIR-endpoint source
- [#252](https://github.com/jwilleke/yourphr/issues/252) — [FEATURE] Harden re-import dedup: guard idempotent upserts against stale (older) overwrites + add coverage
- [#253](https://github.com/jwilleke/yourphr/issues/253) — [FEATURE] Epic: Support manual data entry and user-created records
- [#256](https://github.com/jwilleke/yourphr/issues/256) — [FEATURE] Sharing PHR data
- [#280](https://github.com/jwilleke/yourphr/issues/280) — [FEATURE] Raw fhir-cards: resolve a referenced resource's display name (e.g. Medication/{id})
- [#287](https://github.com/jwilleke/yourphr/issues/287) — [FEATURE] Upload/import UI polish — make all supported file types selectable + clearer 'add my data' affordances
- [#288](https://github.com/jwilleke/yourphr/issues/288) — [ARCH] Decide the future of fasten-sources-stub: fold into the main module vs keep as the owned source layer
- [#300](https://github.com/jwilleke/yourphr/issues/300) — [FEATURE] Angular surface for Medicare claims & coverage (insurance view)
- [#305](https://github.com/jwilleke/yourphr/issues/305) — [FEATURE] Manual records — backend: store/edit/delete user-created records (FHIR-consistent)
- [#307](https://github.com/jwilleke/yourphr/issues/307) — [FEATURE] Manual records — frontend: entry/edit/delete forms
- [#314](https://github.com/jwilleke/yourphr/issues/314) — [FEATURE] Wearable Device Integration for Vitals, Activity & PGHD
- [#333](https://github.com/jwilleke/yourphr/issues/333) — [EPIC] Explore — record export options (Save Report, PDF, Email)
- [#334](https://github.com/jwilleke/yourphr/issues/334) — [FEATURE] Explore — Save Report
- [#335](https://github.com/jwilleke/yourphr/issues/335) — [FEATURE] Explore — Export to PDF
- [#336](https://github.com/jwilleke/yourphr/issues/336) — [FEATURE] Explore — Send to Email
- [#337](https://github.com/jwilleke/yourphr/issues/337) — [BUG] SSE sync events dropped ("Room not found") — import progress never clears
- [#339](https://github.com/jwilleke/yourphr/issues/339) — [FEATURE] athenahealth sandbox — complete Developer-Portal onboarding (approval-gated)
- [#340](https://github.com/jwilleke/yourphr/issues/340) — [FEATURE] Provider logos on Connected Sources — minted UUID brand_id for seeded sandboxes, brand_logo_url override for custom entries
- [#343](https://github.com/jwilleke/yourphr/issues/343) — [FEATURE] Add patient/Observation.rs (+ lab/vital scopes) to the Cerner sandbox seed — no lab values import today
- [#348](https://github.com/jwilleke/yourphr/issues/348) — [FEATURE] Binary import: skip already-stored documents on re-sync (cross-sync existence check)
- [#352](https://github.com/jwilleke/yourphr/issues/352) — [FEATURE] Patient-friendly Body Diagram / Body Map View
- [#353](https://github.com/jwilleke/yourphr/issues/353) — [FEATURE] Patient private notes on records (persist + indicator)
- [#354](https://github.com/jwilleke/yourphr/issues/354) — [FEATURE] Integrate assets from HL7 FHIR GitHub organization (fhir-test-cases, fhir-codegen, etc.)
- [#360](https://github.com/jwilleke/yourphr/issues/360) — [FEATURE] Attach `classified` on resource-graph / list rows (per-row synthesized badges)
- [#364](https://github.com/jwilleke/yourphr/issues/364) — [FEATURE] Admin Database card — polish (free space, schema version, totals, vacuum)
- [#369](https://github.com/jwilleke/yourphr/issues/369) — [FEATURE] /medical-history — server-side grouping endpoint (counts + paged detail) for scale
- [#370](https://github.com/jwilleke/yourphr/issues/370) — [FEATURE] Add VA Clinical Health (FHIR) as a SMART provider
- [#385](https://github.com/jwilleke/yourphr/issues/385) — [EPIC] Realistic test-data corpus + golden-test harness
- [#389](https://github.com/jwilleke/yourphr/issues/389) — [FEATURE] /patient-profile Care Provider
- [#392](https://github.com/jwilleke/yourphr/issues/392) — [FEATURE] Display C4BB files patient-legible layout
- [#393](https://github.com/jwilleke/yourphr/issues/393) — [FEATURE] Live API Sync CARIN framework
- [#402](https://github.com/jwilleke/yourphr/issues/402) — [FEATURE] Admin: show the effective relay URLs and where each value came from

## 🔵 In review

- [#401](https://github.com/jwilleke/yourphr/issues/401) — [SECURITY] SQLCipher unwired by any go-sqlite3 bump — fixed in `bd7abb4e`, **released in v1.13.4**. Unversioned `replace` + fail-closed startup assertion. ⚠️ Hard failure: an instance already running silently-unencrypted will now refuse to boot. Awaiting confirmation the release is running.
- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider — TWO bugs: the unactionable error (`b20e6b13`, v1.13.3) and, the actual blocker, Docker Compose never passing `YOURPHR_*` from `.env` into the container (`5f27821b`, v1.13.4). Reporter has an `environment:` workaround for their current build. **Awaiting their confirmation — my first two sets of instructions were wrong, so this is not done until they say so.**

## ⏸ Deferred

- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)

## ❓ Needs triage

None — every open issue carries a placement label.

## 🔀 Open PRs

3 open, all Dependabot. Two are now unblocked and rebasing; one remains held. None declares a closing reference. All 34 days old (opened 2026-06-25) — **stale by age, but held on purpose, not neglected.**

- [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend *(blocked, stale)* — no linked issue; **held**: `@angular/core@20.3.25` requires `zone.js ~0.15.0`; 0.16.x targets Angular 21. Merge when the project moves to Angular 21.
- [#377](https://github.com/jwilleke/yourphr/pull/377) — chore(deps): bump github.com/go-gormigrate/gormigrate/v2 from 2.1.1 to 2.1.6 *(rebasing, stale)* — likely [#401](https://github.com/jwilleke/yourphr/issues/401); **UNBLOCKED** by `bd7abb4e` — re-verify its checks, then merge.
- [#374](https://github.com/jwilleke/yourphr/pull/374) — chore(deps): bump gorm.io/gorm from 1.30.0 to 1.31.2 *(rebasing, stale)* — likely [#401](https://github.com/jwilleke/yourphr/issues/401); **UNBLOCKED** by `bd7abb4e` — the fix was verified against this exact bump. Re-verify its checks, then merge.
