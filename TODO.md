# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-07-29

- Last worked on: [#405](https://github.com/jwilleke/yourphr/issues/405) — **YourPHR now builds and runs on arm64**, shipped as **v1.16.0**. Both publishing workflows were amd64-only, so `docker pull` hard-failed on Apple Silicon / Pi / ARM VPS. The app image now builds as a native matrix (`ubuntu-latest` + `ubuntu-24.04-arm`, push-by-digest + a `merge` job); the relay cross-compiles on one runner because it is `CGO_ENABLED=0` pure Go. Also filed [#416](https://github.com/jwilleke/yourphr/issues/416) bridging the 12 orphaned Dependabot alerts.
- Branch / state: `main`, clean, pushed, no stashes. Tag `v1.16.0` pushed, GitHub Release published.
- Running / in-flight: **the v1.16.0 release image build ([run 30478751796](https://github.com/jwilleke/yourphr/actions/runs/30478751796)) was still running at wrap** — it is the first *release* build of the new multi-arch workflow. CodeQL on `main` also still running. No dev servers, no containers, nothing local running.
- Parked / half-done: none.
- Next steps:
  - **Confirm the release image actually shipped multi-arch**: `docker buildx imagetools inspect ghcr.io/jwilleke/yourphr:1.16.0` must show both `linux/amd64` and `linux/arm64`. The workflow's own `merge` job asserts this and fails if either is missing, so a green run is sufficient — but the whole point of [#405](https://github.com/jwilleke/yourphr/issues/405) is that a green build is not proof, so pull it. Then Flux should roll `yourphr.nerdsbythehour.com` to 1.16.0 on its own.
  - **[#405](https://github.com/jwilleke/yourphr/issues/405) is fixed but deliberately left open** — close it once the released image is confirmed pullable on arm64.
  - **[#416](https://github.com/jwilleke/yourphr/issues/416) needs your grading call.** Filed `P1`, not the `P0` the security template stamps, because all 12 alerts are `frontend/yarn.lock` build/dev-chain with no path to patient data and no presence in the shipped image (repo precedent for this class is P2, see [#345](https://github.com/jwilleke/yourphr/issues/345)). Re-label if you disagree.
  - **⏰ LIVE INSTANCE, carried over from the last session and still not done.** `yourphr.nerdsbythehour.com` has no `cda-converter` sidecar, and C-CDA is enabled by default since v1.15.1 — XML upload there will report "conversion service unreachable". Deploy `deploy/yourphr-cda-converter.example.yaml` or set `YOURPHR_CDA_CONVERTER_ENABLED=false` in `jwilleke/mj-infra-flux`. No data risk.
  - **UI check still not done, carried over**: log in as `ccdatest` on dev and confirm Eve Betterhalf's 67 C-CDA-derived records actually render. Data in a DB nobody can read is not access.
  - [#397](https://github.com/jwilleke/yourphr/issues/397) — still awaiting the reporter; do not close on our say-so.
- Blockers / significant notes: **The "verify by running" rule paid off again.** The arm64 fix was proven by building and running the image natively on this Apple Silicon machine *before* pushing — build, start, and `https://…/web/` returning HTTP 200 with `<title>YourPHR</title>`, which is what confirmed the CGO/SQLCipher static link works on arm64. That was the one genuinely uncertain part ([#401](https://github.com/jwilleke/yourphr/issues/401)). Two workflow gotchas worth remembering: the per-arch layer cache **must** be `scope=`d or the two runners thrash a shared key, and the manifest list contains `unknown/unknown` attestation entries, so any platform assertion has to filter on `os == linux` rather than counting manifests. Also note `/pstatus` wiped this block earlier in the session — exactly the complaint in [#410](https://github.com/jwilleke/yourphr/issues/410), still unfixed.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- No open issue carries `P0` outside the In review band.
- **12 open Dependabot alerts** (6 high, 6 medium) — now tracked as [#416](https://github.com/jwilleke/yourphr/issues/416), filed `P1` not `P0`: all are `frontend/yarn.lock` build-chain transitives with no path to patient data and no presence in the shipped image. `go.mod` is clean.
- 0 open code-scanning alerts.

## 🟠 P1

- [#416](https://github.com/jwilleke/yourphr/issues/416) — [SECURITY] frontend/yarn.lock build-chain — 12 open Dependabot alerts (postcss, brace-expansion, js-yaml, engine.io, webpack-dev-server, @hono/node-server, picomatch)
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#405](https://github.com/jwilleke/yourphr/issues/405) — [BUG] YourPHR cannot run on arm64 — the published image is amd64-only — **fix merged to `main` (a695db96), awaiting the v1.16.0 release to reach users**
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
- [#415](https://github.com/jwilleke/yourphr/issues/415) — [docs] Manual SMART connect golden-path checklist (relay + catalog)
- [#414](https://github.com/jwilleke/yourphr/issues/414) — [BUG] medical-sources HTML claims BYO SMART form still lives on /sandbox
- [#413](https://github.com/jwilleke/yourphr/issues/413) — [BUG] authorizeSource (BYO) drops redirect_uri from API response mapping
- [#412](https://github.com/jwilleke/yourphr/issues/412) — [docs] Refresh docs/Roadmap.md to match shipped SMART and C-CDA state
- [#411](https://github.com/jwilleke/yourphr/issues/411) — [docs] Fill AGENTS.md Project Context (or point at CLAUDE.md)
- [#410](https://github.com/jwilleke/yourphr/issues/410) — [docs] Restore Resume-here so /pstatus does not wipe session continuity
- [#409](https://github.com/jwilleke/yourphr/issues/409) — [CHORE] Retire or quarantine legacy connect-gateway.service.ts (Fasten Lighthouse)
- [#407](https://github.com/jwilleke/yourphr/issues/407) — [FEATURE] Decide fate of BYO SMART Path B (/source/authorize + /source/connect)
- [#406](https://github.com/jwilleke/yourphr/issues/406) — [FEATURE] SMART connect: fix dual-timeout between relay poll and UI login window
- [#403](https://github.com/jwilleke/yourphr/issues/403) — [ARCH] Evaluate Microsoft FHIR-Converter 5.x (MIT, Liquid) vs the Metriport fork for C-CDA import
- [#393](https://github.com/jwilleke/yourphr/issues/393) — [FEATURE] Live API Sync CARIN framework
- [#392](https://github.com/jwilleke/yourphr/issues/392) — [FEATURE] Display C4BB files patient-legible layout
- [#389](https://github.com/jwilleke/yourphr/issues/389) — [FEATURE] /patient-profile Care Provider
- [#385](https://github.com/jwilleke/yourphr/issues/385) — [EPIC] Realistic test-data corpus + golden-test harness
- [#370](https://github.com/jwilleke/yourphr/issues/370) — [FEATURE] Add VA Clinical Health (FHIR) as a SMART provider
- [#369](https://github.com/jwilleke/yourphr/issues/369) — [FEATURE] /medical-history — server-side grouping endpoint (counts + paged detail) for scale
- [#364](https://github.com/jwilleke/yourphr/issues/364) — [FEATURE] Admin Database card — polish (free space, schema version, totals, vacuum)
- [#360](https://github.com/jwilleke/yourphr/issues/360) — [FEATURE] Attach `classified` on resource-graph / list rows (per-row synthesized badges)
- [#354](https://github.com/jwilleke/yourphr/issues/354) — [FEATURE] Integrate assets from HL7 FHIR GitHub organization (fhir-test-cases, fhir-codegen, etc.)
- [#353](https://github.com/jwilleke/yourphr/issues/353) — [FEATURE] Patient private notes on records (persist + indicator)
- [#352](https://github.com/jwilleke/yourphr/issues/352) — [FEATURE] Patient-friendly Body Diagram / Body Map View
- [#348](https://github.com/jwilleke/yourphr/issues/348) — [FEATURE] Binary import: skip already-stored documents on re-sync (cross-sync existence check)
- [#343](https://github.com/jwilleke/yourphr/issues/343) — [FEATURE] Add patient/Observation.rs (+ lab/vital scopes) to the Cerner sandbox seed — no lab values import today
- [#340](https://github.com/jwilleke/yourphr/issues/340) — [FEATURE] Provider logos on Connected Sources — minted UUID brand_id for seeded sandboxes, brand_logo_url override for custom entries
- [#339](https://github.com/jwilleke/yourphr/issues/339) — [FEATURE] athenahealth sandbox — complete Developer-Portal onboarding (approval-gated)
- [#337](https://github.com/jwilleke/yourphr/issues/337) — [BUG] SSE sync events dropped ("Room not found") — import progress never clears
- [#336](https://github.com/jwilleke/yourphr/issues/336) — [FEATURE] Explore — Send to Email
- [#335](https://github.com/jwilleke/yourphr/issues/335) — [FEATURE] Explore — Export to PDF
- [#334](https://github.com/jwilleke/yourphr/issues/334) — [FEATURE] Explore — Save Report
- [#333](https://github.com/jwilleke/yourphr/issues/333) — [EPIC] Explore — record export options (Save Report, PDF, Email)
- [#314](https://github.com/jwilleke/yourphr/issues/314) — [FEATURE] Wearable Device Integration for Vitals, Activity & PGHD
- [#307](https://github.com/jwilleke/yourphr/issues/307) — [FEATURE] Manual records — frontend: entry/edit/delete forms
- [#305](https://github.com/jwilleke/yourphr/issues/305) — [FEATURE] Manual records — backend: store/edit/delete user-created records (FHIR-consistent)
- [#300](https://github.com/jwilleke/yourphr/issues/300) — [FEATURE] Angular surface for Medicare claims & coverage (insurance view)
- [#288](https://github.com/jwilleke/yourphr/issues/288) — [ARCH] Decide the future of fasten-sources-stub: fold into the main module vs keep as the owned source layer
- [#287](https://github.com/jwilleke/yourphr/issues/287) — [FEATURE] Upload/import UI polish — make all supported file types selectable + clearer 'add my data' affordances
- [#280](https://github.com/jwilleke/yourphr/issues/280) — [FEATURE] Raw fhir-cards: resolve a referenced resource's display name (e.g. Medication/{id})
- [#256](https://github.com/jwilleke/yourphr/issues/256) — [FEATURE] Sharing PHR data.
- [#253](https://github.com/jwilleke/yourphr/issues/253) — [FEATURE] Epic: Support manual data entry and user-created records
- [#252](https://github.com/jwilleke/yourphr/issues/252) — [FEATURE] Harden re-import dedup: guard idempotent upserts against stale (older) overwrites + add coverage
- [#251](https://github.com/jwilleke/yourphr/issues/251) — [FEATURE] Explore Apple Health's supported-institution list as a provider-catalog / FHIR-endpoint source
- [#244](https://github.com/jwilleke/yourphr/issues/244) — [EPIC] Per-profile dashboard widgets (US Core display end-state)
- [#53](https://github.com/jwilleke/yourphr/issues/53) — [SMART] Veradigm/FollowMyHealth registration + end-to-end integration
- [#20](https://github.com/jwilleke/yourphr/issues/20) — [EPIC] SMART on FHIR — live provider sync
- [#14](https://github.com/jwilleke/yourphr/issues/14) — [FEATURE] User Profile Update

## 🔵 In review

- [#397](https://github.com/jwilleke/yourphr/issues/397) — [ISSUE] Unable to Import XML Files From Provider, Error: Error uploading file: C-CDA import is not enabled on this server (set cda_converter.enabled)

## ⏸ Deferred

- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

- None — every open issue carries a placement label.

## 🔀 Open PRs

- [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend *(ready — **stale, open 34 days**)* — no linked issue; held on the Angular 20 peer constraint, and referenced as a known issue by [#416](https://github.com/jwilleke/yourphr/issues/416)
