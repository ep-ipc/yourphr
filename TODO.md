# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-08-11

- Last worked on: **two releases** — [v2.3.0](https://github.com/jwilleke/yourphr/releases/tag/v2.3.0) (bootstrap admin [#504](https://github.com/jwilleke/yourphr/issues/504), demo connect guard [#496](https://github.com/jwilleke/yourphr/issues/496)) and [v2.4.0](https://github.com/jwilleke/yourphr/releases/tag/v2.4.0) (CI-built demo seed [#505](https://github.com/jwilleke/yourphr/issues/505), env-boolean API fix). Then closed the demo lockout hole [#514](https://github.com/jwilleke/yourphr/issues/514) and decided all ten items on [#507](https://github.com/jwilleke/yourphr/issues/507).
- Branch / state: `main` clean, everything pushed, no stashes. All CI green.
- Running / in-flight: **none.** No dev servers, no background agents, ports 9090/9191/9195-9197 free, temp dirs cleaned. One local artifact: `seed/fasten.seed.db` (1.4M, gitignored) from local seed builds — harmless, delete if it bothers you.
- Parked / half-done: none committed-but-unfinished. `#514` is `in-review` and unreleased.
- Next steps:
  - **Configure the demo host** — `private/demo-setup.md` has the current three-step procedure. Three env vars in `mj-infra-flux`, then `rm` the database + `rollout restart`, then read the generated admin password with `kubectl exec … cat`. **Step 2 destroys the SMART Health IT data on that volume** and is the one irreversible action; it needs your go-ahead.
  - **[#506](https://github.com/jwilleke/yourphr/issues/506) password policy** — values already agreed: `username.min.length=3`, `password.min.length=8`, `password.max.length=69` (enforced in BYTES, since bcrypt's ceiling is 72 bytes and UTF-8 is variable width). Note it conflicts with `demo1234`, which contains the username; recommendation is to republish the demo password as `explore2026` rather than exempt the demo account.
  - **[#508](https://github.com/jwilleke/yourphr/issues/508) session revocation** — build before [#510](https://github.com/jwilleke/yourphr/issues/510)/[#511](https://github.com/jwilleke/yourphr/issues/511), which should both bump `token_generation` so a reset actually ends the sessions it is meant to end.
  - **Release** so [#514](https://github.com/jwilleke/yourphr/issues/514) reaches the live demo — it is a P1 fix sitting unreleased.
  - **[#486](https://github.com/jwilleke/yourphr/issues/486)** still wants a human look in **light mode**; nobody has seen the badge fix render. The reporter has been right three times.
- Blockers / significant notes:
  - **Three bugs this session were caught only by running real instances**, never by unit tests: a double-hashed password (the test verified the wrong artifact), `admin` being a reserved username (recommended in my own docs), and `/api/instance/public` serving env-set booleans as **strings** — which made `signup.enabled=false` still advertise the sign-up link. For anything configured by environment, test **through** the environment.
  - **Local `make` cannot validate multi-line Makefile targets.** `.ONESHELL` is line 1 and macOS ships GNU Make 3.81, which predates it — so a `cd`-per-line target passes locally and fails in CI. Cost one red release build. Check CI before tagging, every time.
  - **Chrome automation drives the browser on `jmac`**, not this machine, and `list_connected_browsers` reports `isLocal: true` for both. HackerOne report drafted at `private/reports/2026-08-11-claude-in-chrome-silent-remote-browser-control.md` — **not submitted**.
  - **Demo host is 2.4.0 and unconfigured**: `demo.enabled` false, signup still open, old admin password still lost. Expected, not broken.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

_None._

## 🟠 P1

- [#514](https://github.com/jwilleke/yourphr/issues/514) — [BUG] A demo visitor can lock everyone out of the demo by changing its password or deleting the account
- [#510](https://github.com/jwilleke/yourphr/issues/510) — [FEATURE] fasten reset-password CLI — recover an instance when nobody can sign in
- [#509](https://github.com/jwilleke/yourphr/issues/509) — [FEATURE] Throttle sign-ins per account, not only per IP (both limits configurable)
- [#508](https://github.com/jwilleke/yourphr/issues/508) — [BUG] A stolen session survives a password change — session JWTs cannot be revoked
- [#506](https://github.com/jwilleke/yourphr/issues/506) — [FEATURE] Password policy in configuration, enforced server-side and published to the UI
- [#504](https://github.com/jwilleke/yourphr/issues/504) — [FEATURE] Bootstrap admin: provision the first admin at start with a per-instance random password
- [#511](https://github.com/jwilleke/yourphr/issues/511) — [FEATURE] Admin can set another user's password from Admin → Users
- [#505](https://github.com/jwilleke/yourphr/issues/505) — [FEATURE] Build the demo's seeded database in CI, bake it into the image, restore it in the pod
- [#494](https://github.com/jwilleke/yourphr/issues/494) — [FEATURE] Public demo: seeded demo account + golden-DB reset runbook (demo.yourphr.org)
- [#438](https://github.com/jwilleke/yourphr/issues/438) — [EPIC] demo.yourphr.org — public CMS / sandbox demo instance
- [#436](https://github.com/jwilleke/yourphr/issues/436) — [FEATURE] Support for "Bootstrap" and themas
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- PR: [#492](https://github.com/jwilleke/yourphr/pull/492) — chore(deps): bump ng2-charts from 6.0.1 to 9.0.0 in /frontend _(ready)_ — no linked issue
- PR: [#491](https://github.com/jwilleke/yourphr/pull/491) — chore(deps): bump dwv from 0.31.0 to 0.36.3 in /frontend _(ready, CI red)_ — no linked issue
- PR: [#490](https://github.com/jwilleke/yourphr/pull/490) — chore(deps): bump lforms from 42.2.0 to 43.0.0 in /frontend _(ready)_ — no linked issue
- PR: [#489](https://github.com/jwilleke/yourphr/pull/489) — chore(deps): bump gorm.io/driver/postgres from 1.6.0 to 1.6.2 _(ready)_ — no linked issue
- [#507](https://github.com/jwilleke/yourphr/issues/507) — [FEATURE] Authentication policy survey: password reset, MFA, re-auth, audit — decide what to build
- [#497](https://github.com/jwilleke/yourphr/issues/497) — [FEATURE] Public demo: signup abuse protection on demo.yourphr.org
- [#461](https://github.com/jwilleke/yourphr/issues/461) — [FEATURE] Encrypted database backups (and lift the encryption/backup exclusion)
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
- [#513](https://github.com/jwilleke/yourphr/issues/513) — [FEATURE] Admin → Users: search, summary cards, useful columns, row actions
- [#512](https://github.com/jwilleke/yourphr/issues/512) — [FEATURE] Track last_login and login_count per user (no IPs)
- [#502](https://github.com/jwilleke/yourphr/issues/502) — [ARCH] Evaluate moving Azia's hand-rolled dark stylesheet onto Bootstrap 5.3 colour modes (data-bs-theme)
- [#501](https://github.com/jwilleke/yourphr/issues/501) — [CHORE] Terminology: colour scheme vs colour mode vs theme — settle it and document it
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
- [#455](https://github.com/jwilleke/yourphr/issues/455) — [CHORE] Route all config reads through config.Interface (retire direct os.Getenv and ad-hoc settings files)
- [#415](https://github.com/jwilleke/yourphr/issues/415) — [docs] Manual SMART connect golden-path checklist (relay + catalog)
- [#413](https://github.com/jwilleke/yourphr/issues/413) — [BUG] authorizeSource (BYO) drops redirect_uri from API response mapping
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

## 🔵 In review

Work complete and pushed — awaiting your decision to close.

- [#496](https://github.com/jwilleke/yourphr/issues/496) — [FEATURE] Public demo: block provider connect in demo mode (keep real PHI off the shared account)
- [#495](https://github.com/jwilleke/yourphr/issues/495) — [FEATURE] Public demo: demo-mode flag + one-click "Explore the demo" signin
- [#486](https://github.com/jwilleke/yourphr/issues/486) — Status column text unreadble depending on light/dark mode.
- [#433](https://github.com/jwilleke/yourphr/issues/433) — [FEATURE] Blue Button prod: CMS application, form, and demo runbook

## ⏸ Deferred

- PR: [#424](https://github.com/jwilleke/yourphr/pull/424) — chore(deps): bump angular-eslint from 20.7.0 to 21.0.1 in /frontend _(ready, CI red, stale — open 12d)_ — no linked issue
- PR: [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend _(ready, CI red, stale — open 47d)_ — no linked issue
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

_None — all 84 open issues and 6 open PRs carry a placement label._
