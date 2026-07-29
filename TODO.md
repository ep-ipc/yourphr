# TODO

<!-- RESUME:START -->
## ▶ Resume here — 2026-07-29

- Last worked on: `#411` closed — `AGENTS.md` is the canonical project brief; `CLAUDE.md` is a pointer. SMART flow map + issues `#406`–`#415` earlier; `#413` held for `#407`. Session committed and pushed (`16af8ba6`, `71efb6d4`).
- Branch / state: `main`, clean, synced with `origin/main` (resume-pointer commit may be unpushed until approved)
- Running / in-flight: CI on latest docs push (Markdown Lint + Push on main) may still be in progress at wrap; no local dev servers from this agent
- Parked / half-done: none in working tree
- Next steps:
  - Verify `ghcr.io/jwilleke/yourphr:1.16.0` pulls natively on arm64, then close [#405](https://github.com/jwilleke/yourphr/issues/405)
  - Grade / act on security [#416](https://github.com/jwilleke/yourphr/issues/416) (12 yarn Dependabot alerts)
  - Decide Path B [#407](https://github.com/jwilleke/yourphr/issues/407) (unblocks [#413](https://github.com/jwilleke/yourphr/issues/413))
- Blockers / significant notes: [#397](https://github.com/jwilleke/yourphr/issues/397) still in-review (awaiting reporter). Live instance may still lack cda-converter sidecar (from prior log). Open PR [#378](https://github.com/jwilleke/yourphr/pull/378) zone.js held for Angular 21. Start next session with `/context` (not `/pstatus` first) so this block is read before bands regenerate.
<!-- RESUME:END -->

> Generated from live GitHub state — ranked by priority label.

## 🔴 P0 — Security & Critical

- No open issue carries `P0` outside the In review band.
- **12 open Dependabot alerts** (all `frontend/yarn.lock`) — tracked by [#416](https://github.com/jwilleke/yourphr/issues/416). 0 open code-scanning alerts.

## 🟠 P1

- [#416](https://github.com/jwilleke/yourphr/issues/416) — [SECURITY] frontend/yarn.lock build-chain — 12 open Dependabot alerts (postcss, brace-expansion, js-yaml, engine.io, webpack-dev-server, @hono/node-server, picomatch)
- [#408](https://github.com/jwilleke/yourphr/issues/408) — [FEATURE] Prove one production SMART provider end-to-end via provider catalog
- [#405](https://github.com/jwilleke/yourphr/issues/405) — [BUG] YourPHR cannot run on arm64 — the published image is amd64-only
- [#355](https://github.com/jwilleke/yourphr/issues/355) — [FEATURE] Dynamic Client Registration (DCR)
- [#313](https://github.com/jwilleke/yourphr/issues/313) — [FEATURE] patients able to add records to their own PHR

## 🟡 P2

- [#415](https://github.com/jwilleke/yourphr/issues/415) — [docs] Manual SMART connect golden-path checklist (relay + catalog)
- [#414](https://github.com/jwilleke/yourphr/issues/414) — [BUG] medical-sources HTML claims BYO SMART form still lives on /sandbox
- [#413](https://github.com/jwilleke/yourphr/issues/413) — [BUG] authorizeSource (BYO) drops redirect_uri from API response mapping
- [#412](https://github.com/jwilleke/yourphr/issues/412) — [docs] Refresh docs/Roadmap.md to match shipped SMART and C-CDA state
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
- [#345](https://github.com/jwilleke/yourphr/issues/345) — [security] http-proxy-middleware (webpack-dev-server tree) — blocked on upstream hpm 3.x (GHSA-64mm-vxmg-q3vj)
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

- [#388](https://github.com/jwilleke/yourphr/issues/388) — [ARCH] Extract the FHIR domain logic as a consumable library (own-datastore consumers)
- [#363](https://github.com/jwilleke/yourphr/issues/363) — [FEATURE] Database at-rest encryption: enable/migrate (guarded) + decrypt
- [#351](https://github.com/jwilleke/yourphr/issues/351) — [FEATURE] /medical-history — group & filter by Date (default), Condition, Provider, Place, Type
- [#278](https://github.com/jwilleke/yourphr/issues/278) — [EPIC] Rename Fasten* → YourPHR (deferred; only on committing to a hard fork)
- [#263](https://github.com/jwilleke/yourphr/issues/263) — [FEATURE] Message Provider
- [#239](https://github.com/jwilleke/yourphr/issues/239) — [chore] Revisit gofhir-models 0.1.x once encoding/json/v2 is default in Go
- [#131](https://github.com/jwilleke/yourphr/issues/131) — [FEATURE] E2E testing — remaining gap: lforms questionnaire render + interact

## ❓ Needs triage

None — every open issue carries a placement label.

## 🔀 Open PRs

1 open.

- [#378](https://github.com/jwilleke/yourphr/pull/378) — chore(deps): bump zone.js from 0.15.1 to 0.16.2 in /frontend *(ready)* — **stale** (>7 days) — refs [#44446](https://github.com/jwilleke/yourphr/issues/44446); refs [#45273](https://github.com/jwilleke/yourphr/issues/45273); refs [#47603](https://github.com/jwilleke/yourphr/issues/47603); refs [#51328](https://github.com/jwilleke/yourphr/issues/51328); refs [#55590](https://github.com/jwilleke/yourphr/issues/55590); refs [#61717](https://github.com/jwilleke/yourphr/issues/61717); refs [#61755](https://github.com/jwilleke/yourphr/issues/61755); refs [#62135](https://github.com/jwilleke/yourphr/issues/62135); refs [#63072](https://github.com/jwilleke/yourphr/issues/63072); refs [#63077](https://github.com/jwilleke/yourphr/issues/63077); refs [#63511](https://github.com/jwilleke/yourphr/issues/63511); refs [#64042](https://github.com/jwilleke/yourphr/issues/64042); refs [#64497](https://github.com/jwilleke/yourphr/issues/64497); refs [#67057](https://github.com/jwilleke/yourphr/issues/67057); refs [#68395](https://github.com/jwilleke/yourphr/issues/68395)
