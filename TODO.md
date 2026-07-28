# TODO

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider, Error: "C-CDA import is not enabled on this server (set cda_converter.enabled)"
- **24 open Dependabot alerts, untracked by any issue** (1 critical, 13 high, 10 medium) — all in `frontend/yarn.lock`; `go.mod` is now clean. By decision on 2026-07-28 these are being cleared by merging Dependabot PRs rather than bridged into tracking issues. **[#400](https://github.com/jwilleke/yourphr/pull/400) alone addresses ~12 of them**, including the critical `websocket-driver`.
  - Covered by [#400](https://github.com/jwilleke/yourphr/pull/400): `websocket-driver` (critical), `fast-uri`, `hono`, `immutable`, `linkify-it`, `shell-quote`, `tar`.
  - Not yet covered: `brace-expansion` (x3), `js-yaml` (x3), `webpack-dev-server` (x2), `engine.io`, `picomatch`, `postcss`, `@hono/node-server`.
  - These are build/dev-chain transitives that do not ship in the served image — exposure is a developer machine, not patient data.
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

## 🔵 In review

- [#399](https://github.com/jwilleke/yourphr/issues/399) — Relay definition (partially hard coded in current YourPHR build) — fixed in `07a4f7e5`, shipped in v1.13.1 (image published); awaiting reporter confirmation

## ⏸ Deferred

- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)

## ❓ Needs triage

3 issues awaiting a placement decision:

- [#389](https://github.com/jwilleke/yourphr/issues/389) — [FEATURE] /patient-profile Care Provider
- [#392](https://github.com/jwilleke/yourphr/issues/392) — [FEATURE] Display C4BB files patient-legible layout
- [#393](https://github.com/jwilleke/yourphr/issues/393) — [FEATURE] Live API Sync CARIN framework

## 🔀 Open PRs

8 open, newest first. All are Dependabot bumps; none declares a closing reference.

- [#400](https://github.com/jwilleke/yourphr/pull/400) — chore(deps): bump the npm_and_yarn group across 1 directory with 7 updates *(blocked — checks running)* — no linked issue; clears ~12 Dependabot alerts incl. the critical `websocket-driver`
- [#379](https://github.com/jwilleke/yourphr/pull/379) — chore(deps): bump @angular-eslint/builder from 20.7.0 to 21.0.1 *(conflicted, stale — 33 days)* — no linked issue; peer deps identical between 20.7.0 and 21.0.1, safe once rebased
- [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 *(blocked, stale — 33 days)* — no linked issue; **held deliberately** — `@angular/core@20.3.25` requires `zone.js ~0.15.0`, 0.16.x targets Angular 21
- [#377](https://github.com/jwilleke/yourphr/pull/377) — chore(deps): bump github.com/go-gormigrate/gormigrate/v2 from 2.1.1 to 2.1.6 *(blocked — checks running, stale 33 days)* — no linked issue
- [#376](https://github.com/jwilleke/yourphr/pull/376) — chore(deps): bump golang.org/x/mod from 0.36.0 to 0.37.0 *(blocked — checks running, stale 33 days)* — no linked issue
- [#375](https://github.com/jwilleke/yourphr/pull/375) — chore(deps): bump gorm.io/driver/postgres from 1.5.3 to 1.6.0 *(blocked — checks running, stale 33 days)* — no linked issue
- [#374](https://github.com/jwilleke/yourphr/pull/374) — chore(deps): bump gorm.io/gorm from 1.30.0 to 1.31.1 *(blocked — checks running, stale 33 days)* — no linked issue
- [#373](https://github.com/jwilleke/yourphr/pull/373) — chore(deps): bump github.com/samber/lo from 1.35.0 to 1.53.0 *(blocked — checks running, stale 33 days)* — no linked issue
