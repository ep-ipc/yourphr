# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-08-26

- Last worked on: the whole demo chain landed in TypeScript and demo.yourphr.org left Go — #645 reset, #648 role names, #644 read-only admin tour, #646 the swap itself; the stack folded into this repo (#650, #651, #652) and shipped as v3.0.1 -> v3.1.0.
- Branch / state: main, clean, pushed. mj-infra-flux and yourphr-ts-spike both clean and pushed.
- Running / in-flight: none. No CI in progress, no PRs open, no background agents. Cluster: yourphr-ts on 3.1.0, demo-yourphr-ts on 3.1.0 serving demo.yourphr.org, both Go pods still running and pinned to yourphr-go:2.10.3 as the rollback.
- Parked / half-done: none uncommitted.
- Next steps:
  - #654 — ship `migrate` in the image. The biggest real gap: the upgrade guide tells self-hosters to run a command the image does not have, so nobody can follow it without a source checkout.
  - #653 — fold the 0.x history into CHANGELOG.md (it is preserved at docs/typescript-0.x-changelog.md).
  - #655 — renumber the upgrade doc v2 -> v3 and drop its "not yet true" banner once #654 lands.
  - Then the Go removal, after the demo has held a release cycle: delete backend/, the Go E2E job, and PRUNE `Test Backend` + `Compile Storybook` from branch protection IN THE SAME COMMIT — a required check that stops reporting blocks every PR forever.
- Blockers / significant notes:
  - #658 is P0 and OPEN, cause unknown: pushing v3.1.0 created no workflow run at all. Mitigated (publishing a Release now also builds, and the contract says to verify the run exists) but not diagnosed — the same silence would swallow a security release.
  - The spike repo jwilleke/yourphr-ts-spike is STALE and still publishes images; its main predates #644/#645/#648. #656 archives it.
  - demo.yourphr.org rollback is one Service selector in mj-infra-flux apps/production/demo-yourphr/service.yaml (app: demo-yourphr-ts -> app: demo-yourphr). Note that cloudflared holds keep-alive connections: after flipping it, delete the pod being switched away from or the tunnel keeps serving the old one.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.
> __Open PRs share these bands with issues__ — a PR takes its own placement label, else the highest priority among the issues it links, else Needs triage.

## 🟠 P1

- [#649](https://github.com/jwilleke/yourphr/issues/649) — [EPIC] The TypeScript stack becomes YourPHR v3, in this repository
- [#653](https://github.com/jwilleke/yourphr/issues/653) — [CHORE] CHANGELOG continuity — the v0.x history folded in, 3.0.0 cut here
- [#654](https://github.com/jwilleke/yourphr/issues/654) — [FEATURE] Ship migrate in the image — the upgrade guide already assumes it
- [#655](https://github.com/jwilleke/yourphr/issues/655) — [FEATURE] End-user upgrade docs: renumbered to v2 to v3, and finished
- [#646](https://github.com/jwilleke/yourphr/issues/646) — [FEATURE] Swap demo.yourphr.org to the TypeScript stack — the last Go instance
- [#638](https://github.com/jwilleke/yourphr/issues/638) — [SPIKE] Secrets are not redacted from logs — /admin/logs serves them to any admin
- [#589](https://github.com/jwilleke/yourphr/issues/589) — [security] yarn build-tree moderate advisories: ajv (GHSA-2g4f-4pwh-qvx6), yaml (GHSA-48c2-rrv3-qjmp)
- [#576](https://github.com/jwilleke/yourphr/issues/576) — [security] yarn build-tree high advisories: brace-expansion, cross-spawn, image-size, nanoid, semver
- [#641](https://github.com/jwilleke/yourphr/issues/641) — [SPIKE] Ship a minimal working deployment for each of the three targets — bare metal, Docker, k8s
- [#633](https://github.com/jwilleke/yourphr/issues/633) — [FEATURE] Help content — the pages a patient actually needs
- [#632](https://github.com/jwilleke/yourphr/issues/632) — [FEATURE] In-app help pages — markdown shipped with the code, rendered as HTML
- [#631](https://github.com/jwilleke/yourphr/issues/631) — [SPIKE] Backups must restore the instance, not just the data
- [#628](https://github.com/jwilleke/yourphr/issues/628) — [SPIKE] Refuse to boot when a SQLite database resolves onto a network filesystem
- [#624](https://github.com/jwilleke/yourphr/issues/624) — [SPIKE] Configuration: split the bootstrap flag — it is doing three jobs (raw-env, restart-required, secret)
- [#608](https://github.com/jwilleke/yourphr/issues/608) — [SPIKE] Architecture: build on the ngdpbase model throughout — engine, managers as the only door, config-bound providers, request context (the agreed architecture doc, applied)
- [#591](https://github.com/jwilleke/yourphr/issues/591) — [EPIC] Parity: what the TypeScript stack must do before it replaces yourPHR
- [#588](https://github.com/jwilleke/yourphr/issues/588) — [SPIKE] Phase 5: the cut-over runbook — freeze, migrate, verify, swap, rollback rehearsed
- [#544](https://github.com/jwilleke/yourphr/issues/544) — [EPIC] Transition: freeze Go, build forward in TypeScript
- [#538](https://github.com/jwilleke/yourphr/issues/538) — [CHORE] Phase 0: leave Fasten, stay on Go — adopt the stub under our own name
- [#537](https://github.com/jwilleke/yourphr/issues/537) — [SPIKE] TypeScript stack: prove auth, the HTTP layer and sync, or stop
- [#536](https://github.com/jwilleke/yourphr/issues/536) — [FEATURE] Outbound mail transport: one sender, console by default
- [#494](https://github.com/jwilleke/yourphr/issues/494) — [FEATURE] Public demo: seeded demo account + golden-DB reset runbook (demo.yourphr.org)
- [#438](https://github.com/jwilleke/yourphr/issues/438) — [EPIC] demo.yourphr.org — public CMS / sandbox demo instance
- [#436](https://github.com/jwilleke/yourphr/issues/436) — [FEATURE] Support for "Bootstrap" and themas
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#389](https://github.com/jwilleke/yourphr/issues/389) — [FEATURE] /patient-profile Care Provider
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- [#656](https://github.com/jwilleke/yourphr/issues/656) — [CHORE] Retire jwilleke/yourphr-ts-spike
- [#590](https://github.com/jwilleke/yourphr/issues/590) — [security] yarn build-tree low advisories: body-parser (GHSA-v422-hmwv-36x6), diff (GHSA-73rr-hh4g-fpgx)
- [#532](https://github.com/jwilleke/yourphr/issues/532) — [CHORE] Load webcrypto-liner only when crypto.subtle is missing
- [#507](https://github.com/jwilleke/yourphr/issues/507) — [FEATURE] Authentication policy survey: password reset, MFA, re-auth, audit — decide what to build
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
- [#639](https://github.com/jwilleke/yourphr/issues/639) — [SPIKE] Remove the SOPS Secret — .env on the volume supersedes it
- [#625](https://github.com/jwilleke/yourphr/issues/625) — [ENHANCEMENT] Configuration: did-you-mean suggestions in the unknown-key report
- [#552](https://github.com/jwilleke/yourphr/issues/552) — [CHORE] Port the DICOM viewer to dwv 0.36 — removed APIs and a build path that no longer exists
- [#551](https://github.com/jwilleke/yourphr/issues/551) — [CHORE] Migrate 647 *ngIf uses to Angular built-in control flow (@if/@for)
- [#543](https://github.com/jwilleke/yourphr/issues/543) — [SPIKE] Phase 5: cut over, keep both, or stop — decided once, not by drift
- [#542](https://github.com/jwilleke/yourphr/issues/542) — [SPIKE] Phase 4: the long tail — 22.7k lines with no library to adopt
- [#535](https://github.com/jwilleke/yourphr/issues/535) — [FEATURE] No list view for Organizations (individual ones display fine)
- [#534](https://github.com/jwilleke/yourphr/issues/534) — [CHORE] related_versions.json is tracked but build-generated, so it dirties the tree on every build
- [#502](https://github.com/jwilleke/yourphr/issues/502) — [ARCH] Evaluate moving Azia's hand-rolled dark stylesheet onto Bootstrap 5.3 colour modes (data-bs-theme)
- [#500](https://github.com/jwilleke/yourphr/issues/500) — [FEATURE] ui.theme-name: theme.name is published but wired to nothing — wire it up or remove it
- [#499](https://github.com/jwilleke/yourphr/issues/499) — [FEATURE] ui.color-mode: instance default for light/dark (user's own choice still wins)
- [#487](https://github.com/jwilleke/yourphr/issues/487) — [CHORE] Migrating off Karma must not silently defang the contrast test (jsdom has no real cascade)
- [#485](https://github.com/jwilleke/yourphr/issues/485) — [FEATURE] Reject obfuscated numeric hosts when a source is added, not when it syncs
- [#482](https://github.com/jwilleke/yourphr/issues/482) — [FEATURE] Upgrade angular Angular to 22.x
- [#475](https://github.com/jwilleke/yourphr/issues/475) — [FEATURE] display the bootstrap values
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

- [#650](https://github.com/jwilleke/yourphr/issues/650) — [CHORE] Import the TypeScript stack under server/, with its history
- [#651](https://github.com/jwilleke/yourphr/issues/651) — [CHORE] The TypeScript stack's CI becomes this repository's CI
- [#652](https://github.com/jwilleke/yourphr/issues/652) — [CHORE] One image from this repository, on the 3.x line, and Flux follows it
- [#648](https://github.com/jwilleke/yourphr/issues/648) — [SPIKE] The role column must carry a configured role NAME, not one of two literals
- [#645](https://github.com/jwilleke/yourphr/issues/645) — [FEATURE] Demo mode: reset to a baked-in baseline, proven safe before it destroys anything
- [#644](https://github.com/jwilleke/yourphr/issues/644) — [FEATURE] Demo mode: a read-only demo admin who sees everything and changes nothing
- [#647](https://github.com/jwilleke/yourphr/issues/647) — [SPIKE] Rate-limit the unauthenticated auth endpoints — every sign-in, not just the demo one
- [#643](https://github.com/jwilleke/yourphr/issues/643) — [FEATURE] Demo mode: the shared demo account and its one-click sign-in
- [#642](https://github.com/jwilleke/yourphr/issues/642) — [BUG] Version banner reports the wrong build and a blank environment name

## ⏸ Deferred

- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

- [#561](https://github.com/jwilleke/yourphr/issues/561) — [BUG] Two workflow comments justify a lint exclusion on a premise removed in #241
