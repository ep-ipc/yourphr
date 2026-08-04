# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-08-02

- Last worked on: **v1.21.1** shipped and verified live. v1.21.0 delivered the instance-config chain (#451 `storage.data_dir`, #452 custom config store, #453 `GET /api/instance/public`, #454 footer operator contact, #455 env-read sweep) plus #450 relay semver tags — then **crash-looped prod AND demo** and was fixed by v1.21.1 ~40 min later. Email for yourphr.org is fully working (Cloudflare catch-all → `mjsservers@willeke.com`); DMARC is live via Cloudflare DMARC Management at `p=none`.
- Branch / state: `main` clean, everything pushed, no stashes. `mj-infra-flux` `master` clean and pushed (2 untracked files pre-date this session: `.github/workflows/pat-health-check.yml`, `macos-setings.md`).
- Running / in-flight: **none** — no local dev servers, no background agents. `Push on main` workflow was still running at wrap (cosmetic; CI + Markdown Lint already green on the same commit).
- Parked / half-done: #455 settings-file half — `.backup_settings.json`, `.backup_dest`, `.backup_health.json` still have their own readers, deliberately deferred because that path is backup/restore where a mistake loses data.
- Next steps:
  - Rotate the Cloudflare API token — still live, and it was pasted into a session transcript (`rm ~/.config/cloudflare/token`, then delete at <https://dash.cloudflare.com/profile/api-tokens>)
  - Operator verify in-review: #452 #453 #454 (shipped in v1.21.0/1.21.1) plus older #437 #435 #433
  - `mj-infra-flux`: relay `ImagePolicy` still filters `main-*` — semver tags now exist (`1.21.1`, `1.21`, `latest`), so it can move to semver like the app's policy
  - Mission work: #408 prove one production SMART provider; #438 demo epic remainder; #433 CMS application email when ready
- Blockers / significant notes: **v1.21.0 outage post-mortem is in `private/project_log.md` (`2026-08-02-03`) — read it before touching config resolution.** Root cause: inferring "was this configured?" by comparing a value against its default; a ConfigMap that sets `database.location` to exactly the default string was read as unset and the DB path gained an extra `/db`. Viper cannot answer that question — do not rebuild the inference. Green CI is not deployment evidence: nothing in CI starts the binary against a real data volume. Cluster access is `ssh 192.168.68.71` + `sudo -n kubectl` (this Mac has no kubeconfig). CMS Blue Button sandbox login still broken vendor-side. #413 blocked on #407. Dependabot open: 0.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- PR: [#464](https://github.com/jwilleke/yourphr/pull/464) — chore(deps): bump @angular/common from 20.3.25 to 20.3.27 in /frontend in the npm_and_yarn group across 1 directory _(ready)_ — closes [#478](https://github.com/jwilleke/yourphr/issues/478) only PARTIALLY: bumps @angular/common, leaves @angular/compiler + @angular/core on 20.3.25
- [#478](https://github.com/jwilleke/yourphr/issues/478) — [security] @angular/core + @angular/compiler — i18n XSS via event-handler attributes (2 high alerts) — PR open: [#464](https://github.com/jwilleke/yourphr/pull/464) _(partial fix only)_

## 🟠 P1

- [#479](https://github.com/jwilleke/yourphr/issues/479) — [security] ip-address — SSRF/trust-boundary bypass via CIDR suffix and IPv4-mapped IPv6 (2 medium alerts)
- [#477](https://github.com/jwilleke/yourphr/issues/477) — [FEATURE] Wrap SourceCredential secret fields in config.Secret so credential leaks become impossible
- [#468](https://github.com/jwilleke/yourphr/issues/468) — [FEATURE] Test a backup destination before a schedule can use it
- [#467](https://github.com/jwilleke/yourphr/issues/467) — [FEATURE] Back up the whole data root, not just the database
- [#466](https://github.com/jwilleke/yourphr/issues/466) — [ARCH] Backup model: the data root is exactly what gets backed up
- [#463](https://github.com/jwilleke/yourphr/issues/463) — [FEATURE] Serve PP/ToS from the instance, with an operator override
- [#438](https://github.com/jwilleke/yourphr/issues/438) — [EPIC] demo.yourphr.org — public CMS / sandbox demo instance
- [#436](https://github.com/jwilleke/yourphr/issues/436) — [FEATURE] Support for "Bootstrap" and themas
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- [#480](https://github.com/jwilleke/yourphr/issues/480) — [security] postcss — arbitrary .map file read via attacker-controlled sourceMappingURL
- [#461](https://github.com/jwilleke/yourphr/issues/461) — [FEATURE] Encrypted database backups (and lift the encryption/backup exclusion)
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
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

- [#476](https://github.com/jwilleke/yourphr/issues/476) — [BUG] Six live call sites invoke always-erroring fasten-sources stubs; "unsupported" is indistinguishable from "broken"
- [#437](https://github.com/jwilleke/yourphr/issues/437) — [FEATURE] Split source Disconnect vs Remove data into separate actions
- [#435](https://github.com/jwilleke/yourphr/issues/435) — [BUG] Log level set to error. New lines at this level appear as the server logs activity.
- [#433](https://github.com/jwilleke/yourphr/issues/433) — [FEATURE] Blue Button prod: CMS application, form, and demo runbook

## ⏸ Deferred

- PR: [#424](https://github.com/jwilleke/yourphr/pull/424) — chore(deps): bump angular-eslint from 20.7.0 to 21.0.1 in /frontend _(held)_ — no linked issue
- PR: [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend _(held)_ — no linked issue
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

_None._
