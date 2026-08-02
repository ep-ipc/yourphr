# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-08-01

- Last worked on: **v1.20.3** shipped (sessions #445, disconnect/remove #437, logs #435, SSE #337, CMS runbook #433, PGHD vitals slice #313). Demo: greeting = FHIR Patient (Christopher Abshire from SMART Health IT on **Sandbox**); `/sources` is production-only (empty YourPHR + short **fh** label). Email: Cloudflare Email Routing MX/SPF on for yourphr.org; **`help@yourphr.org`** returns SMTP 550 address does not exist until a CF route is added.
- Branch / state: `main`, clean except possible unpushed wrap commits; HEAD after wrap includes resume refresh
- Running / in-flight: **none** — local dev servers stopped at wrap (`:9090` / `:4200`). Docker image for v1.20.3 built successfully earlier.
- Parked / half-done: none
- Next steps:
  - Push any unpushed wrap commits; confirm CI green (TODO.md MD049 fixed)
  - Cloudflare: create `help@yourphr.org` (or catch-all) Email Routing destination, then test
  - Operator verify in-review (#445 #437 #435 #337); Flux/demo on `1.20.3`
  - CMS application email when ready (#433); mission #408 / #438 remainder; more #313 PGHD
- Blockers / significant notes: CMS Blue Button sandbox login still broken vendor-side. #413 blocked on #407. No DMARC on yourphr.org yet. Dependabot open: 0.
<!-- RESUME:END -->

> Generated from live GitHub state — open issues **and pull requests** ranked together by priority label. PRs are prefixed `PR:` and listed first within their band.

## 🔴 P0 — Security & Critical

_None. Open Dependabot alerts: 0. Open code-scanning alerts: 0._

## 🟠 P1

- [#438](https://github.com/jwilleke/yourphr/issues/438) — [EPIC] demo.yourphr.org — public CMS / sandbox demo instance
- [#436](https://github.com/jwilleke/yourphr/issues/436) — [FEATURE] Support for "Bootstrap" and themas
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj) _(blocked; security)_
- [#455](https://github.com/jwilleke/yourphr/issues/455) — [CHORE] Route all config reads through config.Interface (retire direct os.Getenv and ad-hoc settings files) _(env half shipped in v1.21.0; settings-file half remains)_
- [#415](https://github.com/jwilleke/yourphr/issues/415) — [docs] Manual SMART connect golden-path checklist (relay + catalog)
- [#413](https://github.com/jwilleke/yourphr/issues/413) — [BUG] authorizeSource (BYO) drops redirect_uri from API response mapping _(blocked on #407)_
- [#409](https://github.com/jwilleke/yourphr/issues/409) — [CHORE] Retire or quarantine legacy connect-gateway.service.ts (Fasten Lighthouse)
- [#407](https://github.com/jwilleke/yourphr/issues/407) — [FEATURE] Decide fate of BYO SMART Path B (/source/authorize + /source/connect)
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
- [#339](https://github.com/jwilleke/yourphr/issues/339) — [FEATURE] athenahealth sandbox — complete Developer-Portal onboarding (approval-gated) _(blocked)_
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
- [#53](https://github.com/jwilleke/yourphr/issues/53) — [SMART] Veradigm/FollowMyHealth registration + end-to-end integration _(blocked)_
- [#20](https://github.com/jwilleke/yourphr/issues/20) — [EPIC] SMART on FHIR — live provider sync
- [#14](https://github.com/jwilleke/yourphr/issues/14) — [FEATURE] User Profile Update

## 🔵 In review

- [#454](https://github.com/jwilleke/yourphr/issues/454) — [FEATURE] Render operator contact in footer and About
- [#453](https://github.com/jwilleke/yourphr/issues/453) — [FEATURE] Public instance-info endpoint (allowlisted, unauthenticated)
- [#452](https://github.com/jwilleke/yourphr/issues/452) — [FEATURE] Instance custom config store (app-custom-config.json, deep-merged over defaults)
- [#437](https://github.com/jwilleke/yourphr/issues/437) — [FEATURE] Split source Disconnect vs Remove data into separate actions
- [#435](https://github.com/jwilleke/yourphr/issues/435) — [BUG] Log level set to error. New lines at this level appear as the server logs activity.
- [#433](https://github.com/jwilleke/yourphr/issues/433) — [FEATURE] Blue Button prod: CMS application, form, and demo runbook

## ⏸ Deferred

- PR: [#424](https://github.com/jwilleke/yourphr/pull/424) — chore(deps): bump angular-eslint from 20.7.0 to 21.0.1 in /frontend _(ready · **CI red**: Lint Frontend FAILURE · merge state BLOCKED)_ — held for Angular 21 — no linked issue (Dependabot open alerts: 0)
- PR: [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend _(ready · **stale** since 2026-06-25 · **CI red**: Test Frontend + Test Backend FAILURE · merge state BLOCKED)_ — held for Angular 21 — no linked issue (Dependabot open alerts: 0)
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt _(security)_
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten_ → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

_None — every open issue and PR carries a placement label._
