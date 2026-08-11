# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-08-05

- Last worked on: **three releases today** — [v2.1.0](https://github.com/jwilleke/yourphr/releases/tag/v2.1.0) (whole-data-root backups #467, destination testing #468, SSRF guard fixed at dial time #484, credentials wrapped in `config.Secret` #477), [v2.1.1](https://github.com/jwilleke/yourphr/releases/tag/v2.1.1) (served PP/ToS: dead link, maintainer text, stray `<br>`), [v2.1.2](https://github.com/jwilleke/yourphr/releases/tag/v2.1.2) (status-badge contrast #486 + a contrast test, footer Terms link, Contact placeholder). All three verified live on demo; the badge fix confirmed present in the shipped CSS bundle, not just by version number.
- Branch / state: `main` clean, everything pushed, no stashes. `mj-infra-flux` `master` clean and pushed (the 2 untracked files there pre-date this session).
- Running / in-flight: **none.** No dev servers, no background watchers, port 9191 free, all CI green.
- Parked / half-done: none.
- Next steps:
  - **[#481](https://github.com/jwilleke/yourphr/issues/481) — the only P0.** E2E silently attaches to a stale backend on `:9191` and reports application failures for environmental reasons. Cost a false "did the Angular bump break auth?" investigation today.
  - **11 items `in-review`** awaiting a close/keep decision, including [#486](https://github.com/jwilleke/yourphr/issues/486) (external), [#463](https://github.com/jwilleke/yourphr/issues/463), [#466](https://github.com/jwilleke/yourphr/issues/466), [#476](https://github.com/jwilleke/yourphr/issues/476), [#484](https://github.com/jwilleke/yourphr/issues/484).
  - **Eyeball a status badge on demo in both modes** — [#486](https://github.com/jwilleke/yourphr/issues/486). Claude was confident and wrong about this twice; measured contrast passing is not the same as it reading well, and the reporter deserves a human confirmation.
  - **Rotate the Cloudflare API token** — still live, and it was pasted into a session transcript (`rm ~/.config/cloudflare/token`, then delete at <https://dash.cloudflare.com/profile/api-tokens>).
  - **Demo Instance card** — needs an admin session: `operator.name` = "Jim Willeke, DBA services.willeke.biz", `operator.contact_email` = `admin@yourphr.org`, clear `operator.contact_url`.
  - **Run the restore drill** on a throwaway container — [`docs/recovery/data-recovery.md`](docs/recovery/data-recovery.md). v2.1.0 changed the archive format and what restore replaces, and that page argues you should not trust a backup you have never restored. That currently includes yours.
- Blockers / significant notes:
  - **Both scanners are at zero.** 12 Dependabot alerts cleared; 14 high CodeQL `go/path-injection` alerts **dismissed** as won't fix per [#488](https://github.com/jwilleke/yourphr/issues/488), citing [#466](https://github.com/jwilleke/yourphr/issues/466). Dismissed alerts are never re-raised by a later scan — `docs/recovery/backup-model.md` records the conditions that would make that dismissal wrong (more than one admin, a hosted/multi-tenant deployment, a destination settable by a non-admin).
  - **Check code scanning, not just Dependabot, before releasing.** Those 14 alerts were introduced in v2.1.0 and shipped in two releases because only Dependabot was being checked.
  - **Verify tooling output before concluding from an absence.** A regex that matched nothing was read as proof a CSS rule did not exist; it had simply truncated. That produced a public wrong root cause on [#486](https://github.com/jwilleke/yourphr/issues/486).
  - **Rollout timing is unpredictable.** The `Docker (YourPHR)` arm64 leg has ranged 12–44 minutes this week. Watch the run; do not estimate from the tag. Also: docs-only commits are path-filtered and produce **no** `CI` run — "no run" and "passed" look identical if you only glance at the list.
  - New standing rule in memory: **external issues/PRs always get thanks + encouragement and a priority bump.** `TODO.md` now ranks them first within their band.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- [#481](https://github.com/jwilleke/yourphr/issues/481) — [BUG] E2E silently runs against a stale backend when one is already on :9191

## 🟠 P1

- PR: [#493](https://github.com/jwilleke/yourphr/pull/493) — chore(deps): bump hono from 4.12.32 to 4.13.1 in /frontend in the npm_and_yarn group across 1 directory _(ready)_ — likely [#503](https://github.com/jwilleke/yourphr/issues/503)
- [#503](https://github.com/jwilleke/yourphr/issues/503) — [security] hono — SSR memo() cross-request leak, language-middleware DoS, proxy header leak (2 medium, 1 low) — PR open: [#493](https://github.com/jwilleke/yourphr/pull/493)
- [#496](https://github.com/jwilleke/yourphr/issues/496) — [FEATURE] Public demo: block provider connect in demo mode (keep real PHI off the shared account)
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
- [#497](https://github.com/jwilleke/yourphr/issues/497) — [FEATURE] Public demo: signup abuse protection on demo.yourphr.org
- [#461](https://github.com/jwilleke/yourphr/issues/461) — [FEATURE] Encrypted database backups (and lift the encryption/backup exclusion)
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
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

- [#498](https://github.com/jwilleke/yourphr/issues/498) — [FEATURE] signup.enabled: let an operator close self-service account creation (first run always exempt)
- [#484](https://github.com/jwilleke/yourphr/issues/484) — [BUG] SSRF guard is bypassed by any non-dotted-quad IP form — decimal, hex or short — reaching loopback and cloud metadata
- [#483](https://github.com/jwilleke/yourphr/issues/483) — [security] Build-tree dependency sweep — ip-address, fast-uri, socket.io-parser, undici (3 high, 3 medium)
- [#480](https://github.com/jwilleke/yourphr/issues/480) — [security] postcss — arbitrary .map file read via attacker-controlled sourceMappingURL
- [#479](https://github.com/jwilleke/yourphr/issues/479) — [security] ip-address — SSRF/trust-boundary bypass via CIDR suffix and IPv4-mapped IPv6 (2 medium alerts)
- [#495](https://github.com/jwilleke/yourphr/issues/495) — [FEATURE] Public demo: demo-mode flag + one-click "Explore the demo" signin
- [#486](https://github.com/jwilleke/yourphr/issues/486) — Status column text unreadble depending on light/dark mode.
- [#476](https://github.com/jwilleke/yourphr/issues/476) — [BUG] Six live call sites invoke always-erroring fasten-sources stubs; "unsupported" is indistinguishable from "broken"
- [#466](https://github.com/jwilleke/yourphr/issues/466) — [ARCH] Backup model: the data root is exactly what gets backed up
- [#463](https://github.com/jwilleke/yourphr/issues/463) — [FEATURE] Serve PP/ToS from the instance, with an operator override
- [#437](https://github.com/jwilleke/yourphr/issues/437) — [FEATURE] Split source Disconnect vs Remove data into separate actions
- [#435](https://github.com/jwilleke/yourphr/issues/435) — [BUG] Log level set to error. New lines at this level appear as the server logs activity.
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

_None — all 85 open issues and 7 open PRs carry a placement label._
