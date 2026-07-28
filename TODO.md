# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-07-28

- Last worked on: [#399](https://github.com/jwilleke/yourphr/issues/399) — external user reported the SMART OAuth `redirect_uri` was hardcoded. Root cause: the Angular frontend built it from a compile-time constant (`environment.relay_endpoint_base`), baked into the bundle at image build; `YOURPHR_RELAY_URL` only fed the backend's `/pending` poll. Fixed in `07a4f7e5` — `redirect_uri` is now derived by the backend at request time, relay settings moved onto viper (`relay.url` / `relay.public_url` / `relay.secret`), and `GET /api/secure/source/relay-config` reports the effective callback URL. Released as **v1.13.1** (`9d63bdb8`).
- Branch / state: `main`, clean, pushed. Tag `v1.13.1` pushed; GitHub Release published and marked Latest.
- Running / in-flight: `Docker (YourPHR)` image build for `v1.13.1` — confirm it published `ghcr.io/jwilleke/yourphr:1.13.1`, then that Flux rolled the live instance.
- Parked / half-done: none.
- Next steps:
  - **Verify [#399](https://github.com/jwilleke/yourphr/issues/399) on the reporter's instance** once v1.13.1 is out; comment the version on the issue and close only after they confirm. Their report spelled the secret `YOURPHR_REALY_SECRET` — if literal, it is silently ignored (the new `relay-config` endpoint reports `configured: false`).
  - **Dependency security sweep — 23 open Dependabot alerts** (see P0 band). Sequence upgrade-first; most are frontend build-chain transitives, so triaging the 16 open Dependabot PRs likely clears the bulk.
  - **Triage 5 unlabeled/new issues**: [#389](https://github.com/jwilleke/yourphr/issues/389), [#392](https://github.com/jwilleke/yourphr/issues/392), [#393](https://github.com/jwilleke/yourphr/issues/393) carry only `enhancement` (no priority band); [#397](https://github.com/jwilleke/yourphr/issues/397) has no labels at all.
  - **[#397](https://github.com/jwilleke/yourphr/issues/397) is a live user hitting a wall** — C-CDA/XML import fails with "C-CDA import is not enabled on this server". Same class of problem as #399: a self-hoster blocked by configuration that isn't discoverable. Worth prioritizing.
  - Verify RxTerms live on prod (yourphr.nerdsbythehour.com → Current Medications; behind Authentik).
- Blockers / significant notes: delivery is release-gated — pushes to `main` build no image. The dev server at `192.168.68.111:4200` (`make serve-frontend-lan`) is unrelated to the release path; it proxies `/api` to `localhost:9090`, so a local backend must be running on the same machine.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label. The `▶ Resume here` pointer is written by `/wrap`.

## 🔴 P0 — Security & Critical

- **23 open Dependabot alerts** — 1 critical, 12 high, 10 medium. 22 of 23 are in `frontend/yarn.lock`, 1 in `go.mod`.
  - `go.mod`: HIGH `golang.org/x/image` — fix is merging [#390](https://github.com/jwilleke/yourphr/pull/390).
  - `frontend/yarn.lock`: critical `websocket-driver`; high `brace-expansion`, `js-yaml`, `shell-quote`, `fast-uri`, `linkify-it`, `immutable`, `engine.io`; medium `webpack-dev-server`, `tar`, `hono`, `@hono/node-server`, `morgan`.
  - Reality check before treating the whole set as urgent: most of these are **build/dev-chain transitives** (webpack-dev-server, hono, engine.io) that never ship in the served image, so the real exposure is a developer's machine, not a patient's data. Confirm which are runtime vs dev before spending a release on them.
  - Dependabot's grouped frontend security job runs and succeeds repeatedly but opens **no** grouped security PR — worth checking whether it can't find an upgrade path. [#345](https://github.com/jwilleke/yourphr/issues/345) tracks the `http-proxy-middleware` piece (blocked on upstream hpm 3.x).
- 0 open code-scanning alerts.

## 🟠 P1

- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)

## 🟡 P2

- [#14](https://github.com/jwilleke/yourphr/issues/14) — [FEATURE] User Profile Update
- [#20](https://github.com/jwilleke/yourphr/issues/20) — [EPIC] SMART on FHIR — live provider sync
- [#53](https://github.com/jwilleke/yourphr/issues/53) — [SMART] Veradigm/FollowMyHealth registration + end-to-end integration (blocked)
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
- [#339](https://github.com/jwilleke/yourphr/issues/339) — [FEATURE] athenahealth sandbox — complete Developer-Portal onboarding (blocked, approval-gated)
- [#340](https://github.com/jwilleke/yourphr/issues/340) — [FEATURE] Provider logos on Connected Sources — brand_id / brand_logo_url override
- [#343](https://github.com/jwilleke/yourphr/issues/343) — [FEATURE] Add patient/Observation.rs (+ lab/vital scopes) to the Cerner sandbox seed — no lab values import today
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
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

- [#399](https://github.com/jwilleke/yourphr/issues/399) — Relay definition (partially hard coded in current YourPHR build) — fixed in `07a4f7e5`, shipped in v1.13.1; awaiting reporter confirmation

## ⏸ Deferred

- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (only on committing to a hard fork)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date/Condition/Provider/Place/Type
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)

## ❓ Needs triage

- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider — "C-CDA import is not enabled on this server (set cda_converter.enabled)". **No labels at all.** A real user blocked on undiscoverable configuration; same shape as [#399](https://github.com/jwilleke/yourphr/issues/399).
- [#389](https://github.com/jwilleke/yourphr/issues/389) — [FEATURE] /patient-profile Care Provider (no priority band)
- [#392](https://github.com/jwilleke/yourphr/issues/392) — [FEATURE] Display C4BB files patient-legible layout (no priority band)
- [#393](https://github.com/jwilleke/yourphr/issues/393) — [FEATURE] Live API Sync CARIN framework (no priority band)
