# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-08-13

- Last worked on: **v2.6.1 released and live on the demo**, fixing why refused actions reported nothing ([#527](https://github.com/jwilleke/yourphr/issues/527)). Then drafted [`docs/planning/authorization-framework.md`](docs/planning/authorization-framework.md) — the authorization half the authentication doc deferred, derived from ngdpbase's `WikiContext`.
- Branch / state: `main`, clean, everything pushed, no stashes. Release CI fully green on `0060686f`; both images built.
- Running / in-flight: **none.** Demo is serving 2.6.1 (`main.590ccaf44403417b.js`).
- Parked / half-done: none.
- Next steps:
  - **Click-test the two [#527](https://github.com/jwilleke/yourphr/issues/527) fixes on the live demo** — as `demoadmin`, press **Delete** on `/web/admin/provider-catalog` and **Download backup** on `/web/admin/database`. Each should show the server's read-only sentence inline, plus a notification top-right that now stays until dismissed. Frontend-only fixes, so only a browser proves them — unit tests were green while the app was broken, which is the whole lesson of this session.
  - **Answer the sharpest open question in the authorization draft** — is the role-to-permission mapping configuration or compiled in? It collides with the standing "variables belong in configuration" rule ([#472](https://github.com/jwilleke/yourphr/issues/472)); here that would let a config-store typo silently widen access to medical records. A middle position is written up in the doc. Once the doc is shaped, split it into one issue per phase with blocked-by chains.
  - **Decide the demo's dead admin buttons** — offered, not filed. Every write control on the admin screens looks live and is refused on press; the fix is the `demo.admin.session` flag plus `[disabled]` and a reason, ~1 hour, following the `medical-sources` precedent from [#496](https://github.com/jwilleke/yourphr/issues/496). Phase 4 of the authorization framework deletes it, which is fine — it stops the demo teaching visitors the app is broken in the meantime.
  - **Decide the demo login-stat gap** — [#512](https://github.com/jwilleke/yourphr/issues/512) records only in `AuthSignin`, so the demo's one-click entrances never move `last_login`/`login_count`. Every account on the demo will read "Never" forever. Either document it or record demo sign-ins too.
  - **Verify the in-review batch** — [#509](https://github.com/jwilleke/yourphr/issues/509)–[#513](https://github.com/jwilleke/yourphr/issues/513) are shipped and awaiting your decision to close.
  - **Six Dependabot PRs** still open and untouched ([#492](https://github.com/jwilleke/yourphr/pull/492), [#491](https://github.com/jwilleke/yourphr/pull/491), [#490](https://github.com/jwilleke/yourphr/pull/490), [#489](https://github.com/jwilleke/yourphr/pull/489), [#424](https://github.com/jwilleke/yourphr/pull/424), [#378](https://github.com/jwilleke/yourphr/pull/378)).
- Blockers / significant notes:
  - **A green unit suite proved nothing about DI wiring.** `app.module.ts` registered the auth interceptor with an explicit `deps: [AuthService, Router]` — inherited from upstream Fasten commit `03294610` — against a three-argument constructor, so `toastService` was `undefined` in every shipped build while the spec, which registers it *without* `deps`, stayed green. An explicit `deps` array replaces a class's own injection metadata and goes stale silently; do not add one.
  - **`models.AccessToken` has no scopes field.** Every access token is exactly as powerful as whoever minted it. The `Scopes` on `ProviderCatalogEntry` are outbound SMART scopes requested from Epic and Cerner — unrelated, and easy to conflate.
  - **A bare URL in an issue title turns CI red.** [#524](https://github.com/jwilleke/yourphr/issues/524)'s title contains one, `TODO.md` is generated from titles, and MD034 rejects it — `/pstatus` and `/session-commit` now say to wrap URLs from title text in angle brackets. When reproducing a Markdown Lint failure locally, lint `git ls-files '*.md'`: a plain glob surfaces ~87 errors in gitignored files CI never sees.
  - **The demo runs from a golden database**, not the public seed — `bootstrap.seed.path` points at `/opt/fasten/db/golden/fasten.golden.db`, which carries your own `jwilleke` admin. It survived two schema migrations on the 2.6.0 rollout.
  - **`gh issue create --template` cannot use YAML forms**, which is why both bug templates exist; do not "tidy up" by deleting the markdown one.
  - **The AOT build (`npx ng build`) is the only real frontend gate.** `tsc --noEmit` and Karma both pass on template errors that break the production build.
  - **Chrome automation drives the browser on `jmac`**, not this machine. HackerOne report drafted at `private/reports/2026-08-11-claude-in-chrome-silent-remote-browser-control.md` — **not submitted**.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

*None.*

## 🟠 P1

- [#530](https://github.com/jwilleke/yourphr/issues/530) — [SECURITY] elliptic 6.5.0 ships in the bundle via webcrypto-liner, and Dependabot cannot see it
- [#526](https://github.com/jwilleke/yourphr/issues/526) — [FEATURE] Enable Debug mode vs Show Raw FHIR
- [#525](https://github.com/jwilleke/yourphr/issues/525) — [BUG] practitioners (Count Error)
- [#524](https://github.com/jwilleke/yourphr/issues/524) — [FEATURE] Send to Email (<https://demo.yourphr.org/web/>)
- [#523](https://github.com/jwilleke/yourphr/issues/523) — [FEATURE] /web/medical-history  "Save Report"
- [#522](https://github.com/jwilleke/yourphr/issues/522) — [FEATURE] ExplanationOfBenefit Display
- [#521](https://github.com/jwilleke/yourphr/issues/521) — [FEATURE] Claim - display this resource type
- [#506](https://github.com/jwilleke/yourphr/issues/506) — [FEATURE] Password policy in configuration, enforced server-side and published to the UI
- [#494](https://github.com/jwilleke/yourphr/issues/494) — [FEATURE] Public demo: seeded demo account + golden-DB reset runbook (demo.yourphr.org)
- [#438](https://github.com/jwilleke/yourphr/issues/438) — [EPIC] demo.yourphr.org — public CMS / sandbox demo instance
- [#436](https://github.com/jwilleke/yourphr/issues/436) — [FEATURE] Support for "Bootstrap" and themas
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#389](https://github.com/jwilleke/yourphr/issues/389) — [FEATURE] /patient-profile Care Provider
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- PR: [#492](https://github.com/jwilleke/yourphr/pull/492) — chore(deps): bump ng2-charts from 6.0.1 to 9.0.0 in /frontend *(ready)* — no linked issue
- PR: [#491](https://github.com/jwilleke/yourphr/pull/491) — chore(deps): bump dwv from 0.31.0 to 0.36.3 in /frontend *(CI red — 3 failing)* — no linked issue
- PR: [#490](https://github.com/jwilleke/yourphr/pull/490) — chore(deps): bump lforms from 42.2.0 to 43.0.0 in /frontend *(ready)* — no linked issue
- PR: [#489](https://github.com/jwilleke/yourphr/pull/489) — chore(deps): bump gorm.io/driver/postgres from 1.6.0 to 1.6.2 *(ready)* — no linked issue
- [#531](https://github.com/jwilleke/yourphr/issues/531) — [security] go/clear-text-logging — 2 high CodeQL alerts in demoSignin, both false positives
- [#507](https://github.com/jwilleke/yourphr/issues/507) — [FEATURE] Authentication policy survey: password reset, MFA, re-auth, audit — decide what to build
- [#502](https://github.com/jwilleke/yourphr/issues/502) — [ARCH] Evaluate moving Azia's hand-rolled dark stylesheet onto Bootstrap 5.3 colour modes (data-bs-theme)
- [#500](https://github.com/jwilleke/yourphr/issues/500) — [FEATURE] ui.theme-name: theme.name is published but wired to nothing — wire it up or remove it
- [#499](https://github.com/jwilleke/yourphr/issues/499) — [FEATURE] ui.color-mode: instance default for light/dark (user's own choice still wins)
- [#487](https://github.com/jwilleke/yourphr/issues/487) — [CHORE] Migrating off Karma must not silently defang the contrast test (jsdom has no real cascade)
- [#485](https://github.com/jwilleke/yourphr/issues/485) — [FEATURE] Reject obfuscated numeric hosts when a source is added, not when it syncs
- [#482](https://github.com/jwilleke/yourphr/issues/482) — [FEATURE] Upgrade angular Angular to 22.x
- [#475](https://github.com/jwilleke/yourphr/issues/475) — [FEATURE] display the bootstrap values
- [#473](https://github.com/jwilleke/yourphr/issues/473) — [FEATURE] Warn about configuration keys that have no effect
- [#472](https://github.com/jwilleke/yourphr/issues/472) — [CHORE] Reference deployment: env carries bootstrap and secrets, not settings
- [#471](https://github.com/jwilleke/yourphr/issues/471) — [FEATURE] Show which provider entries were provisioned from environment variables
- [#469](https://github.com/jwilleke/yourphr/issues/469) — [CHORE] Remove AllowedBackupRoots, keep path hygiene
- [#465](https://github.com/jwilleke/yourphr/issues/465) — [FEATURE] Record the document digest on the consent record
- [#462](https://github.com/jwilleke/yourphr/issues/462) — [FEATURE] Share records as a SMART Health Link (shlink)
- [#461](https://github.com/jwilleke/yourphr/issues/461) — [FEATURE] Encrypted database backups (and lift the encryption/backup exclusion)
- [#455](https://github.com/jwilleke/yourphr/issues/455) — [CHORE] Route all config reads through config.Interface (retire direct os.Getenv and ad-hoc settings files)
- [#415](https://github.com/jwilleke/yourphr/issues/415) — [docs] Manual SMART connect golden-path checklist (relay + catalog)
- [#413](https://github.com/jwilleke/yourphr/issues/413) — [BUG] authorizeSource (BYO) drops redirect_uri from API response mapping
- [#409](https://github.com/jwilleke/yourphr/issues/409) — [CHORE] Retire or quarantine legacy connect-gateway.service.ts (Fasten Lighthouse)
- [#407](https://github.com/jwilleke/yourphr/issues/407) — [FEATURE] Decide fate of BYO SMART Path B (/source/authorize + /source/connect)
- [#393](https://github.com/jwilleke/yourphr/issues/393) — [FEATURE] Live API Sync CARIN framework
- [#392](https://github.com/jwilleke/yourphr/issues/392) — [FEATURE] Display C4BB files patient-legible layout
- [#385](https://github.com/jwilleke/yourphr/issues/385) — [EPIC] Realistic test-data corpus + golden-test harness
- [#370](https://github.com/jwilleke/yourphr/issues/370) — [FEATURE] Add VA Clinical Health (FHIR) as a SMART provider
- [#369](https://github.com/jwilleke/yourphr/issues/369) — [FEATURE] /medical-history — server-side grouping endpoint (counts + paged detail) for scale
- [#364](https://github.com/jwilleke/yourphr/issues/364) — [FEATURE] Admin Database card — polish (free space, schema version, totals, vacuum)
- [#360](https://github.com/jwilleke/yourphr/issues/360) — [FEATURE] Attach `classified` on resource-graph / list rows (per-row synthesized badges)
- [#354](https://github.com/jwilleke/yourphr/issues/354) — [FEATURE] Integrate assets from HL7 FHIR GitHub organization (fhir-test-cases, fhir-codegen, etc.)
- [#353](https://github.com/jwilleke/yourphr/issues/353) — [FEATURE] Patient private notes on records (persist + indicator)
- [#352](https://github.com/jwilleke/yourphr/issues/352) — [FEATURE] Patient-friendly Body Diagram / Body Map View
- [#348](https://github.com/jwilleke/yourphr/issues/348) — [FEATURE] Binary import: skip already-stored documents on re-sync (cross-sync existence check)
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
- [#343](https://github.com/jwilleke/yourphr/issues/343) — [FEATURE] Add patient/Observation.rs (+ lab/vital scopes) to the Cerner sandbox seed — no lab values import today
- [#340](https://github.com/jwilleke/yourphr/issues/340) — [FEATURE] Provider logos on Connected Sources — minted UUID brand_id for seeded sandboxes, brand_logo_url override for custom entries
- [#339](https://github.com/jwilleke/yourphr/issues/339) — [FEATURE] athenahealth sandbox — complete Developer-Portal onboarding (approval-gated)
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

## 🔵 In review — shipped, awaiting verification

*None.*

## ⏸ Deferred

- PR: [#424](https://github.com/jwilleke/yourphr/pull/424) — chore(deps): bump angular-eslint from 20.7.0 to 21.0.1 in /frontend *(CI red — 1 failing)* — no linked issue
- PR: [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend *(CI red — 2 failing)* — no linked issue
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

*None.*
