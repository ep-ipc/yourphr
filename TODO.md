# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-07-28

- Last worked on: Dependabot sweep (14 of 17 PRs merged, alerts **24 → 12**, critical cleared), released **v1.13.1** ([#399](https://github.com/jwilleke/yourphr/issues/399) relay `redirect_uri`) and **v1.13.2** (security/deps), fixed [#397](https://github.com/jwilleke/yourphr/issues/397) C-CDA discoverability (`b20e6b13`, unreleased), and found [#401](https://github.com/jwilleke/yourphr/issues/401) — a latent regression that would silently disable DB encryption.
- Branch / state: `main`, clean, pushed, no stashes.
- Running / in-flight: none. Dev servers stopped (`:9090`/`:4200` free). Last CI on `main` green (`b20e6b13`); `820ada6d` is docs-only. `v1.13.2` image published.
- Parked / half-done: none committed. **Local frontend Karma runner is broken here** — missing `@babel/helper-hoist-variables`, absent from `node_modules` and `yarn.lock`, yet CI passes from the same lockfile (corrupt local yarn cache; `rm -rf node_modules` + reinstall did not fix). Until repaired, frontend changes are only verifiable via CI.
- Next steps:
  - **[#401](https://github.com/jwilleke/yourphr/issues/401) — highest value.** `go.mod:10` pins `replace github.com/mattn/go-sqlite3 v1.14.17 => jgiannuzzi/go-sqlite3` (the SQLCipher fork). ANY bump past 1.14.17 stops the replace matching, so Go silently links upstream mattn with **no SQLCipher** — a PHR writing PHI unencrypted while still reporting encryption on. Cheapest guard: assert the active cipher at startup and refuse to boot when `database.encryption.enabled` is true. [#374](https://github.com/jwilleke/yourphr/pull/374) / [#377](https://github.com/jwilleke/yourphr/pull/377) stay blocked (auto-merge disabled) until this is resolved.
  - **Cut `v1.13.3`** to ship the [#397](https://github.com/jwilleke/yourphr/issues/397) fix — it is on `main` but unreleased, so the next person to hit it still gets the old dead-end error. (The current reporter is already unblocked by config.)
  - Await reporter confirmation on [#397](https://github.com/jwilleke/yourphr/issues/397) and [#399](https://github.com/jwilleke/yourphr/issues/399) — both `in-review`, neither self-closed.
  - Repair the local frontend yarn cache.
  - Backlog: P1 [#313](https://github.com/jwilleke/yourphr/issues/313) / [#355](https://github.com/jwilleke/yourphr/issues/355); 12 remaining Dependabot alerts (all `frontend/yarn.lock` build-chain).
- Blockers / significant notes: **Verify with the Makefile targets CI uses** (`make test-backend`, `make test-frontend-coverage`) and report the EXIT CODE — twice this session an empty filtered `go test` output was misread as success, leaving `main` red and v1.13.1 tagged from it (test-only; shipped code unaffected). Also: `gh pr merge --auto` does NOT re-run stale checks — a PR blocked on a failure recorded against a broken `main` needs `@dependabot rebase`. Do not batch-arm auto-merge on dependency PRs without reading each diff — [#374](https://github.com/jwilleke/yourphr/pull/374) was armed with checks pending and would have merged the encryption regression unattended. After Go merges run `go mod vendor`; after frontend merges run `make dep-frontend`; `make test-backend` rewrites `backend/resources/related_versions.json` with a local git-describe — revert, never commit.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- No open issue carries `P0` other than [#397](https://github.com/jwilleke/yourphr/issues/397), which is in review (see below).
- **12 open Dependabot alerts** (7 high, 5 medium), down from 24 — all in `frontend/yarn.lock`; `go.mod` is clean. Remaining: `brace-expansion` (x3), `js-yaml` (x3), `webpack-dev-server` (x2), `engine.io`, `picomatch`, `postcss`, `@hono/node-server`. These are build/dev-chain transitives that do not ship in the served image — exposure is a developer machine, not patient data. Not bridged into tracking issues by decision on 2026-07-28; clear them by merging Dependabot PRs.
- 0 open code-scanning alerts.

## 🟠 P1

- [#401](https://github.com/jwilleke/yourphr/issues/401) — [SECURITY] SQLCipher driver is unwired by any go-sqlite3 bump — version-pinned replace directive silently disables DB encryption
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

## 🔵 In review

- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider (C-CDA import not enabled) — fixed in `b20e6b13`, **not yet released**; reporter can unblock today with config alone (`YOURPHR_CDA_CONVERTER_ENABLED` + `_URL` + `docker compose --profile cda up -d`). Awaiting their confirmation.
- [#399](https://github.com/jwilleke/yourphr/issues/399) — Relay definition (partially hard coded in current YourPHR build) — fixed in `07a4f7e5`, shipped in v1.13.1 (image published). Awaiting reporter confirmation.

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

3 open, all Dependabot, all deliberately blocked. None declares a closing reference.

- [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend *(blocked, stale — 33 days)* — no linked issue; **held**: `@angular/core@20.3.25` requires `zone.js ~0.15.0`, 0.16.x targets Angular 21. Merge when the project moves to Angular 21.
- [#377](https://github.com/jwilleke/yourphr/pull/377) — chore(deps): bump github.com/go-gormigrate/gormigrate/v2 from 2.1.1 to 2.1.6 *(blocked, stale — 33 days)* — likely [#401](https://github.com/jwilleke/yourphr/issues/401); **held**, auto-merge disabled: drags `go-sqlite3` past the pinned replace and silently disables DB encryption.
- [#374](https://github.com/jwilleke/yourphr/pull/374) — chore(deps): bump gorm.io/gorm from 1.30.0 to 1.31.1 *(blocked, stale — 33 days)* — likely [#401](https://github.com/jwilleke/yourphr/issues/401); **held**, auto-merge disabled: same SQLCipher regression as #377.
