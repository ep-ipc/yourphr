# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-07-29

- Last worked on: [#404](https://github.com/jwilleke/yourphr/issues/404) C-CDA out-of-box (shipped v1.15.0, closed) and its end-to-end testing, which **caught three defects that had already shipped**. Filed [#405](https://github.com/jwilleke/yourphr/issues/405) (arm64) and ran the [#403](https://github.com/jwilleke/yourphr/issues/403) converter head-to-head. **Nine releases today: v1.13.1 → v1.15.1.**
- Branch / state: `main`, clean, pushed, no stashes. CI green (one docs-only `Push on main` may still be finishing).
- Running / in-flight: dev servers **UP** — frontend `:4200`, backend `:9090`. **The `cda-dev` converter container is DEAD** (exited 137 ~46 min ago, likely a Docker restart), and the backend still points at `localhost:18080` — so C-CDA upload on dev will fail with the "unreachable" error until you `docker start cda-dev` or re-run it. Everything else on dev works.
- Parked / half-done: none uncommitted.
- Next steps:
  - **[#405](https://github.com/jwilleke/yourphr/issues/405) (P1) — top recommendation.** The **app** image is amd64-only (`docker-jwilleke.yaml` → `platforms: linux/amd64`), so `docker pull` hard-fails on Apple Silicon / Pi / ARM VPS with an error that never mentions architecture. YourPHR is *uninstallable* for those users — that outranks any feature. Upstream Fasten built multi-arch; this fork narrowed it. Likely blocker: the CGO/SQLCipher link. **Verify by pulling on arm64, not by a green build** — the converter fix today proved a build passing ≠ an image working.
  - **⏰ LIVE INSTANCE.** `yourphr.nerdsbythehour.com` has no `cda-converter`, and v1.15.1 enables C-CDA by default. Once Flux rolls, XML upload there reports "conversion service unreachable". Deploy the sidecar (`deploy/yourphr-cda-converter.example.yaml`) or set `YOURPHR_CDA_CONVERTER_ENABLED=false` in `jwilleke/mj-infra-flux`. No data risk.
  - **UI check still not done** — log in as `ccdatest` / `devpassword` on `localhost:4200` and confirm Eve Betterhalf's **67 C-CDA-derived records actually render**. Blocked only because the Chrome extension was not connected. Data in a DB nobody can read is not access.
  - **12 Dependabot alerts** — no PR, no issue. All `frontend/yarn.lock` build-chain transitives (no path to patient data). Needs a decision, not work.
  - [#397](https://github.com/jwilleke/yourphr/issues/397) — awaiting the reporter. **Do not close on our say-so; my instructions to them were wrong twice.**
  - Stale fixture `ccda_to_fhir_converted_C-CDA_R2-1_CCD.xml.json` (65 vs current 67 resources) — refresh or annotate; it is no longer ground truth.
  - [#403](https://github.com/jwilleke/yourphr/issues/403) — head-to-head done and it **argues against switching**: Metriport 67 resources vs Microsoft 61, with CarePlan absent from Microsoft entirely. Keep open for HL7v2 + MIT only.
- Blockers / significant notes: **Verify by RUNNING, not by reasoning.** Three defects shipped today and every one was caught by executing something — the arm64 break (`docker pull`), a `setup_hint` pointing at a compose profile the same release deleted (live endpoint call), and a drifted test fixture (real conversion). Unit tests, CI and `docker compose config` passed cleanly through all three. **Three hypotheses also reversed on inspection**: per-document-type templates were not a gap (`ccd.hbs` is a strict superset of all 8 others — do not "fix" this); the Metriport pin was not stale (it *is* current `develop` HEAD); Microsoft does not convert better (it converts less). Corollaries: assert removed strings are **absent** (positive-only assertions let content rot); filter CI waits by **workflow AND commit** (a `--limit 3` window once fired on unrelated runs); `Fixes #NNN` in a commit **auto-closes** the issue, which bypasses the leave-closes-to-Jim convention (#401 and #404 both went that way); `make test-backend` rewrites `backend/resources/related_versions.json` — revert, never commit. Dev accounts (7 + `ccdatest`) share the password in `private/secrets.md`.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- No open issue carries `P0` outside the In review band.
- **12 open Dependabot alerts** (7 high, 5 medium) — all `frontend/yarn.lock`; `go.mod` clean. **No Dependabot PR covers any of them**, and they have no tracking issue either. Build/dev-chain transitives only: no path to patient data, exposure is a developer machine. Needs a decision — bridge to issues, investigate why Dependabot opens no PRs, or explicitly accept.
- 0 open code-scanning alerts.

## 🟠 P1

- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#405](https://github.com/jwilleke/yourphr/issues/405) — [BUG] YourPHR cannot run on arm64 — the published image is amd64-only

## 🟡 P2

- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
- [#14](https://github.com/jwilleke/yourphr/issues/14) — [FEATURE] User Profile Update
- [#20](https://github.com/jwilleke/yourphr/issues/20) — [EPIC] SMART on FHIR — live provider sync
- [#53](https://github.com/jwilleke/yourphr/issues/53) — [SMART] Veradigm/FollowMyHealth registration + end-to-end integration
- [#244](https://github.com/jwilleke/yourphr/issues/244) — [EPIC] Per-profile dashboard widgets (US Core display end-state)
- [#251](https://github.com/jwilleke/yourphr/issues/251) — [FEATURE] Explore Apple Health's supported-institution list as a provider-catalog / FHIR-endpoint source
- [#252](https://github.com/jwilleke/yourphr/issues/252) — [FEATURE] Harden re-import dedup: guard idempotent upserts against stale (older) overwrites + add coverage
- [#253](https://github.com/jwilleke/yourphr/issues/253) — [FEATURE] Epic: Support manual data entry and user-created records
- [#256](https://github.com/jwilleke/yourphr/issues/256) — [FEATURE] Sharing PHR data.
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
- [#403](https://github.com/jwilleke/yourphr/issues/403) — [ARCH] Evaluate Microsoft FHIR-Converter 5.x (MIT, Liquid) vs the Metriport fork for C-CDA import

## 🔵 In review

- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider (C-CDA import not enabled) — **two root causes, both fixed and released**: the unactionable error (v1.13.3) and Docker Compose never passing `YOURPHR_*` into the container (v1.13.4). C-CDA now works out of the box as of v1.15.0. **Awaiting the reporter — my instructions to them were wrong twice, so this does not close on our say-so.**

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

1 open, 34 days old — **held deliberately, not neglected**.

- [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend *(conflicted/failing, stale — 34 days)* — no linked issue; **held**: `@angular/core@20.3.25` requires `zone.js ~0.15.0` and 0.16.x targets Angular 21. Its CI is red against a base predating today's commits, so it needs a rebase before any result means anything. Merge when the project moves to Angular 21.
