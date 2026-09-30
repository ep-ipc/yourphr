# Review: yourphr#314 wearable / device samples, fork `ep-ipc/yourphr` branch `sat-apple-health-ts`

Reviewed for Jim Willeke on 2026-09-30. This was a read-only review: nothing was posted to GitHub and nobody was contacted.

- Branch head: `4bc619949` ("docs: add proposal for implementing 314"), 14 commits. Authors are Scott Teglasi / steglasaurous, plus one commit by Parth Kheni (`4ca9c2b91`, the MCP bridge).
- Merge-base with upstream: `de8f0a92c` (2026-09-14). Upstream `main` is now `20a068eb0` (2026-09-29). **The branch is 145 commits behind** (13 of those landed after `baf0121`).
- Diff against the merge-base: 61 files, +8,973 / −66. By area: server src +2,684, server tests +1,066, frontend Health page +4,198, other frontend +324, MCP bridge +210, docs +420, Docker +56.
- **It does not merge cleanly into main.** A trial merge has 8 conflicted files: `src/server.ts`, `src/app.ts`, `src/account/index.ts`, `scripts/check-routes.ts`, `scripts/mcp-server.ts`, `scripts/mcp-tests.ts`, `frontend/src/app/app.module.ts`, and `frontend/src/app/pages/settings/settings.component.ts`.

## Recommendation

**Go ahead with changes, and split it.** The sample store, catalog and ingest/read API fit yourPHR's manager/provider pattern well and are worth taking. The pairing credential needs a redesign before any of it merges. Today it is a never-expiring, full-account token (admin rights included) that can be traded for a normal browser session. That contradicts #695/#719, and main has already deleted the screen it depends on. The sleep terminology also needs fixing before the first merge, because the wrong codes are persisted.

## Summary

Scott's design choice is sound and well argued. Wearable samples do not go through the FHIRPath-indexed `SqliteFhirRepository`. They live in dedicated `health_samples` / `health_sync_states` tables behind `HealthManager` → `SqliteHealthProvider`, keyed by `user_id = ctx.username`, idempotent on `(user_id, external_uuid)`, and rebuilt as FHIR R4 Observations/Bundles on read. The catalog (`src/app/health/catalog.ts`) maps HealthKit and Health Connect keys onto LOINC + UCUM. Eight of the nine LOINC codes are correct (verified against tx.fhir.org). The ninth, sleep, is not. Account deletion, the access log ("Health" category), the demo write-refusal, the agent-token default-deny gate and store/HTTP boundaries are all respected. The server tests are real and pass.

The problems cluster in four places:

1. **Credential model.** The device token is a full user credential (`ApiContext.device(owner, ownerRole…)`), including admin. `/api/auth/companion-session` turns it into a human session. It defaults to "No Expiration" (year 2099), has no per-user cap, no lifecycle audit, and no feature flag. It survives a password change and "sign out everywhere". I verified all of this against a running server (below).
2. **Terminology.** Four of the six stored SNOMED sleep codes do not exist, and the other two mean "Facial profile convex" and "Therapeutic regimen". `89129007` (REM sleep) is accepted as an alias for *Awake*. LOINC `93832-4` is "Sleep duration", not a stage, and `sleep` is not an HL7 observation-category code.
3. **Sync semantics.** Blood-pressure halves that arrive in different batches lose the diastolic. Updates and deletes never propagate. Days are bucketed in UTC and the source offset is thrown away, so a Pacific-time night is split in two. Overlapping sources (iPhone + Watch steps) are summed with no de-duplication.
4. **Mergeability and scope.** The branch is 145 commits behind with 8 conflicts. It revives the pairing screen and the two Go-era routes that main deliberately deleted in #719 (`25504a4c4`). CI is red: `check:routes` fails, and a host-dependent discovery unit test fails. It also bundles unrelated work (a distroless Dockerfile, `angular.json` asset/sourcemap changes, header CSS).

**I could not find the iOS or Android apps.** They are not in this branch, in the fork's other branches (`main`, `sat-apple-health`, `archive/chat`), or in any public repo under `ep-ipc` or `steglasaurous` (checked 2026-09-30). The apps could not be reviewed at all. Every mobile-side statement below is a question, not a finding.

## Test, typecheck and lint results

I ran everything on Node 24.21.0 on the box, on the branch and on the merge-base `de8f0a92c` for comparison. `npm ci --ignore-scripts` was used because the box has no `make`; the SQLCipher prebuilds load fine, which is also how the Dockerfile installs.

| Check | Merge-base | Branch |
|---|---|---|
| `typecheck`, `build`, `check:boundary`, `check:store` | pass | pass |
| `check:routes` | pass | **FAIL**: "KNOWN_MISSING entries the server now routes": `/api/secure/access/token`, `/api/secure/sync/discovery` (yourphr#719) |
| `test:coverage` (vitest) | 372/372 pass | **1 fail** / 423 pass. `src/app/__tests__/discovery.test.ts:54` expects `['http://172.17.0.2:8080']` but got the box hostname. `serverBaseUrls` calls `os.hostname()` un-injected (`src/app/discovery.ts:161`), so the result depends on the host. It will very likely fail on GitHub runners too. |
| `framework, ssrf, smart, sync, auth, agent-tokens, mcp-tests (28/28), config, env, backup, worker, migrations, ips, provenance, medication, records, dcr, app, migrate, web, migrate:tool, process, demo-reset, lint:md, check:phi` | pass | pass |
| `device-tokens` (new) | n/a | pass (20/20) |
| Frontend Karma, `src/app/pages/health/**` specs only (ChromeHeadless) | n/a | **1 fail** / 48 pass. `health-visit-summary.spec.ts:147` expects `page-break-inside: avoid`, but the CSS is minified (`page-break-inside:avoid`, `health-visit-summary.ts:466`). |
| ESLint on the changed frontend files | n/a | **1 error**: `health.component.ts:414` `@typescript-eslint/array-type`. There are also 32 warnings, mostly pre-existing lines in `fasten-api.service.ts` / `settings.component.ts`. |

**Fork CI:** GitHub Actions "Server CI (TypeScript)" fails on the branch head `4bc619949` (and on the four prior pushes) at the **Route contract** step. Every later step was skipped, so the discovery-test failure never surfaced there. The E2E job passed. I did not run the full Angular test suite, full `ng lint`, the Storybook build, or a Docker build.

## Findings

File:line references are on the branch head `4bc619949` unless noted. Findings marked **(verified)** were reproduced against a live server started from the branch with a scratch script. The scripts are saved in `/workspace/reports/yourphr-314-probes/`.

### HIGH

**H1. The device token is a full-account credential, admin included (verified).**
`src/server.ts:559-567` builds `ApiContext.device(owner, roleOf(owner), …)`, and `ApiContext.canRead()` / `can()` place no restriction on `viaDevice` (`src/framework/ApiContext.ts:169-182`).

With a token minted by an admin account, the probe got:
- `200` on `GET /api/secure/admin/config`
- `200` on `PUT /api/secure/admin/instance`
- `200` on `POST /api/secure/admin/users` creating a new **admin** user
- `200` on `DELETE /api/secure/account/me`, which deleted the whole account

A lost phone, or a screenshot of the QR code, is therefore full account takeover until someone notices and revokes it. The comment at `src/app.ts:418` says "a full user credential, not a scoped agent", so this is intentional. It is still the opposite of #695's decisions: scopes only narrow, unscoped is refused, `admin-*` is refused outright, and roles are never inherited silently.

**H2. `POST /api/auth/companion-session` turns the device token into a human session (verified).**
The route is at `src/server.ts:514-539` and calls `sessions.issueFor(device.owner)` at `:531`. The resulting cookie is an ordinary human session, so it passes `requireHuman` (`src/app/managers/DeviceTokensManager.ts:74-79`). From it, the probe minted **another** device token (`200`) and an agent token with the `Full export` scope (`200`).

The proposal's statement "A device token cannot mint another device token" is therefore false end-to-end. The branch's own harness even asserts the escalation as a feature: `scripts/device-token-tests.ts:163` "the exchanged cookie is a human session and can list device tokens".

**H3. The token lifecycle is weaker than the agent tokens already on main (verified).**
- The default is "No Expiration" (`frontend/.../settings.component.ts:26-33`, `newDeviceExpiration = 0`), which resolves to `2099-12-31` (`DeviceTokensManager.ts:32,106`).
- There is no max-per-user, no mint/revoke audit event (AgentTokensManager records these), and no feature flag: the manager is always registered (`src/app.ts:419`).
- After a password change **and** "sign out everywhere", both the original device token and the one minted from the phone-derived session still answered `200`.

Main's #719 work (`25504a4c4`) removed exactly this "No Expiration" option, and per your comment on #719 a test now fails if a never-expiring option reappears.

**H4. The sleep terminology is wrong and gets persisted (verified against tx.fhir.org, SNOMED International 2025-02-01).**
In `src/app/health/catalog.ts:174-263`:

| Stored code | Used for | What it actually is |
|---|---|---|
| `248218006` | Awake | not found |
| `248219008` | Light sleep | not found |
| `248218000` | REM sleep | not found |
| `248220008` | Deep sleep | "Asleep" |
| `248171000` | Asleep | "Facial profile convex" |
| `133877004` | In bed | "Therapeutic regimen" |

The alias `89129007` in the *Awake* list (`catalog.ts:191`) is "Rapid eye movement sleep". For comparison, "Awake" is `248218005`.

Other problems in the same area:
- The metric is coded LOINC `93832-4`, which is "Sleep duration", a quantity, not a stage.
- `category: 'sleep'` is not in `http://terminology.hl7.org/CodeSystem/observation-category` (tx.fhir.org: "Unable to find code 'sleep'").
- `2708-6` is "Oxygen saturation in Arterial blood". The pulse-oximetry code is `59408-5` (US Core Pulse Oximetry uses both).

These codes are written into `value_text` on every sleep row and exported in Observations and the MCP bridge. Fixing them after users have data needs a data migration, so fix them before the first merge.

**H5. The branch conflicts with decisions on main, and CI is red.**
- 145 commits behind, 8 conflicted files.
- The branch re-routes `/api/secure/access/token` and `/api/secure/sync/discovery` and re-uses the QR pairing screen. #719 (closed 2026-09-25) replaced that screen with the agent-key screen and planned to **delete** those routes, because "the companion mobile app does not exist".
- `check:routes` fails for exactly that reason, and the discovery test is host-dependent (see the table above).

### MED

**M1. Blood pressure loses data (verified).**
`mergeBloodPressure` (`src/app/managers/HealthManager.ts:389-411`) only merges within one request. The first half creates a panel row whose `external_uuid` is the correlation id. The second half, arriving in a later batch, hits `ON CONFLICT(user_id, external_uuid) DO NOTHING` (`SqliteHealthProvider.ts:173`) and is reported as a "duplicate". The probe confirmed that only the systolic value was stored.

Separately, a standalone systolic (`8480-6`) or diastolic Observation is rejected ("blood_pressure requires component values"). That happens because `BY_CODE` maps component codes onto the panel (`catalog.ts:274-277`). Home cuffs and FHIR exports do produce standalone systolic/diastolic Observations.

**M2. Updates and deletes never propagate.**
Ingest is insert-or-ignore only (`SqliteHealthProvider.ts:167-189`), and there is no delete or tombstone path. HealthKit anchored queries report deletions, and Health Connect records can be updated in place under the same id. A sample the user deletes or edits on the phone stays unchanged in yourPHR forever.

**M3. Timezones (verified for sleep).**
- All day buckets use SQLite `date(start_time)` in UTC (`SqliteHealthProvider.ts:364-366, 424-426`). For you in ET, steps after 8 pm EDT count toward the next day.
- The sleep "night" is `date(start_time, '-12 hours')` (`:435-438`), so the cutover is 12:00 UTC, which is 05:00 PDT. In the probe, one 22:00–07:00 PDT night came back as two nights: `2026-09-09` Light 6 h and `2026-09-10` REM 1.5 h.
- `parseTime` (`HealthManager.ts:130-135`) converts to UTC and throws away the source offset, so local days cannot be rebuilt later.
- A timestamp without an offset is accepted and parsed in the **server's** local timezone.

**M4. Overlapping sources are double-counted.**
`mode=day` is `SUM(value_num)` over every row (`SqliteHealthProvider.ts:363-367`), with no source priority or overlap handling. When iPhone and Apple Watch both record steps, which is the normal case, daily totals roughly double if the companion sends raw samples. Apple's own Health totals de-duplicate by source priority. This comes from reading the code; I did not test it with real HealthKit output.

**M5. Health Connect integer sleep stages are mis-mapped (verified).**
The numeric aliases `'0'`–`'5'` (`catalog.ts:189-255`) are HealthKit raw values. Health Connect uses different constants (verified from the Android docs): UNKNOWN=0, AWAKE=1, SLEEPING=2, OUT_OF_BED=3, LIGHT=4, DEEP=5, REM=6, AWAKE_IN_BED=7. In the probe, `SleepSessionRecord` with `value_text: "4"` (Health Connect LIGHT) was stored as "Deep sleep". Whether the Android app actually sends integers is unknown, because its source isn't available. In the exported Observation, the Health Connect key is also coded under the Apple HealthKit system URL (`observation.ts:122-127`, `catalog.ts:15`).

**M6. Scale (measured, with extrapolation clearly marked).**
I inserted 1,000,000 heart-rate rows at a 5-second cadence (about 58 days) directly through the provider:

| Measurement | Result |
|---|---|
| Insert time | 10.3 s |
| Database size | 448 MB (~448 bytes/row) |
| `points` over the whole history (no window) | 1.95 s, +93 MB RSS |
| `points` over the last 7 days | 0.18 s |
| `daily-stats` over the whole history | 1.7 s |
| `metrics` summary | 0.7 s |

Extrapolated, not measured: one year at 5 s ≈ 6.3 M rows ≈ 2.8 GB per person. That volume would land in the shared app database (`spike.db`) next to accounts, sessions and the audit log, and in every backup of it.

`seriesPoints` and `seriesDailyStats` load every row in the window into JavaScript before downsampling (`SqliteHealthProvider.ts:277-279, 372-374`). better-sqlite3 is synchronous, so the event loop is blocked for that whole time. There is no rollup table and no retention policy. Real Apple Watch heart-rate cadence is usually much lower at rest, so this is a worst case.

**M7. Transport and discovery.**
The QR's base URLs use `https` only when `yourphr.web.secure-cookies` is true (`src/server.ts:836`). That ties TLS to a cookie flag, and the default is `false`, so the QR steers phones to plain-`http://` LAN addresses. Given H1/H3, that means a never-expiring full-account Bearer token crosses Wi-Fi in cleartext.

Also:
- The new unprefixed `HOST_IP` / `HOST_PORT` env aliases (`src/config/index.ts` `unprefixedEnvNameFor`) collide with a common Kubernetes downward-API convention (`HOST_IP` = node IP).
- `sync_endpoint` still advertises `api/secure/resource/fhir` (`src/app/discovery.ts:172`), not the ingest route.

**M8. FHIR output validity and PGHD provenance.**
- `meta.source` is set to a display string like "Apple Watch" (`observation.ts:119-121`). In R4 `meta.source` is a `uri`.
- `Bundle.total` is set on a `collection` Bundle (`observation.ts:148-153`), which violates `bdl-1`.
- An unknown metric's `valueCodeableConcept` keeps only the code (`HealthManager.ts:305-306`) and is later re-labelled SNOMED (`observation.ts:104-111`).
- There is no patient-generated marker (`performer` → Patient, or a `meta.tag`) and no Device resource, although #314 asks for "patient-generated provenance" and Device/DeviceMetric.
- `src/provenance/index.ts` (the "From <source> · first received…" surface) is not used for samples.

**M9. Subject binding.**
`subjectFor` takes "the first Patient" from `records.list(ctx, 'Patient', {limit: 1})` (`HealthManager.ts:448-458`). The proposal names this as an open question. Two consequences:
- An account with several connected sources has several Patient resources, each with a source-scoped id, so "first" is arbitrary.
- The reference dangles if that source is removed.

With yourPHR's one-account-per-member household model this is tolerable for a first cut, but it should be explicit.

**M10. PHI moves into the app database.**
Until now the clinical record lived in the records database behind `RecordsManager` (the backup "exporter"), while the app DB held accounts, sources, catalog and audit. Samples now live in the app DB. Encryption at rest follows the same opt-in key, so this is **no worse** than today, but the volume of PHI under that opt-in model grows a lot. "Full export" does not include samples (the proposal lists this as an open follow-up).

### LOW

- **L1. Input limits.** There are no per-metric value ranges (negative heart rate is accepted), no length caps on `source_name`, `device_name`, `external_uuid` or `metadata` (anything up to the 8 MiB body), and far-future timestamps are accepted. `anchors` has no cap, and each anchor is a separate, un-transactioned upsert (`HealthManager.ts:516-528`).
- **L2. Token exposure in the UI.** `settings.component.ts:76` has `console.log('Generate token response:', response)`, which prints the cleartext token to the browser console. The line is pre-existing but is now live. The raw QR JSON is also shown in a textarea with a copy button.
- **L3. Schema management.** There are three migrations for a schema that was never released (including an `hk_type` → `vendor_type` rename), plus provider-side `ALTER TABLE` / `RENAME COLUMN` at construction (`SqliteHealthProvider.ts:145-163`, duplicating `src/app.ts:228-256`). Upstream should get one migration with the final schema.
- **L4. Units.** Only `kg` and `Cel` are accepted; `lb` and `degF` are rejected (verified). Rejecting is safer than silently storing wrong units, but should be documented, or converted server-side. `C` is accepted as Celsius, though in UCUM `C` means coulomb.
- **L5. Scope creep.** The branch also contains:
  - a distroless runtime image (no shell, new `ENTRYPOINT`)
  - `angular.json` changes that narrow the lforms asset globs and turn off sourcemaps (a risk to questionnaire rendering; not verified)
  - mobile header CSS and a dashboard tile
  - account deletion now also removing agent tokens (`server.ts:759-761`). This is a genuine fix worth taking on its own.
- **L6.** `Math.min(...allValues)` / `Math.max(...)` spread over panel series (`SqliteHealthProvider.ts:301-302, 386-387`) would throw `RangeError` on very large blood-pressure series. This is latent.
- **L7.** `verify()` writes `last_used_at` on every request (`DeviceTokensManager.ts:122`), which is an extra app-DB commit per call.
- **L8.** The clinician visit summary asserts device facts regardless of the actual source ("Measured overnight by the watch", "Continuous optical sensor": `health-visit-summary.ts` `qualityNote`, around lines 1105-1115). HTML escaping in the generated summary looked correct (`escapeHtml` on every interpolated field I checked).

### Relation to the 2026-09-29 security review

- Missing security headers: this branch adds none, and adds a cookie-issuing route (`companion-session`). The visit summary is a downloaded file, not a served page.
- Guarded-fetch Bearer-over-redirect: not touched. No new outbound fetch under `src/`, and `check:boundary` passes.
- Opt-in encryption with the key beside the data: samples inherit it. That is no worse in kind, but it means much more PHI.
- The branch does make the transport situation worse in practice (M7), because it encourages plain-HTTP LAN use with a long-lived full-account Bearer token.

## Test coverage and gaps

What is covered well:
- manager/provider ingest, idempotency, rejects, anchors, per-account isolation, and the blood-pressure merge within one batch
- series modes and account deletion
- token mint/verify/revoke, including cross-account and "a device cannot manage tokens"
- the HTTP edge: an agent cannot POST ingest, and a device token presented as a cookie is refused
- discovery ordering

What is not covered:
- device tokens against admin routes, account deletion, full export, or source writes (H1)
- the session-exchange escalation (H2), which is asserted as desired behaviour
- revocation on password change or sign-out-everywhere
- blood pressure split across batches, and standalone systolic/diastolic
- update/delete semantics
- timezone-offset inputs and non-UTC day/night bucketing
- Health Connect numeric stages
- volume/performance
- validating emitted Observations and Bundles against R4 / US Core
- a terminology snapshot test (it would have caught H4)
- the pairing Settings UI has no spec (main's replacement has one)
- nothing at all for the mobile apps, which are not available

## Maintainability, licensing, distribution, and the ngdpbase move

- **Size.** About 9 k lines in one branch, 4.2 k of them in the Health page and visit summary. It needs splitting to be reviewable (see Phasing).
- **Dependencies.** None added: `package.json` changes only a script, and the frontend `package.json` is unchanged. It reuses chart.js/ng2-charts and `@medplum/fhirtypes`. No licensing issue from the diff itself.
- **Native apps.** No source is available. If they come to yourPHR, someone has to own two native codebases (Swift/HealthKit, Kotlin/Health Connect) and the recurring costs: an Apple Developer account ($99/yr), a Play developer account, and store review. HealthKit apps need a privacy policy. Google Play requires a Health Connect permissions declaration and review. Self-hosted apps that ask for a server URL have to get through review, often with a demo server.
  - Licensing: yourPHR is GPLv3. The FSF has long argued App Store terms conflict with GPL distribution (the 2011 VLC removal). If the apps are GPLv3 and include yourPHR/fasten-derived code (the WebView idea), App Store distribution may need an additional-permission exception from all copyright holders. A thin native client under a permissive license, in a separate repo, avoids most of that.
  - TestFlight, sideloading and F-Droid are the realistic early channels.
- **Contributor provenance.** Most commits use a corporate address (`@experiencepoint.com`) from the `ep-ipc` fork org, and one commit is by a different author. It may be worth a light confirmation that the contribution is intended under GPLv3.
- **ngdpbase move** (`docs/planning/ngdp-move.md` on main):
  - `HealthManager` and `SqliteHealthProvider` follow the "managers move unchanged, `ctx` passed in" rule, so the storage half survives the migration well. It also uses `better-sqlite3-multiple-ciphers`, which the doc says PHI stores still need.
  - The credential half complicates it. The doc calls the `server.ts` gate layer (session + Bearer, agent-token gate, demo gate, access-log gate) "the bulk of the work", and this branch adds a third bearer type plus a token-to-session exchange that would all have to be re-expressed.
  - An ingest credential built as a **scoped extension of the agent-token model** (one write scope, one route) maps directly onto ngdpbase's `AgentTokenManager` + `tokenRouteMap` default-deny, and would carry over almost for free.

## Requested changes (for "go ahead with changes")

1. **Rebase on current main.** Drop the revived QR pairing screen and the Go-era `/api/secure/access/token` + `/api/secure/sync/discovery` routes (removed on purpose in #719). Get CI green, including a hermetic discovery test (inject `hostname`) or dropping discovery for now.
2. **Replace the full-account device token with a narrowly scoped ingest credential.** Preferably extend the agent-token model: a single write scope such as `health:write`, allowed only on `POST /api/secure/health/samples` (and `GET /api/secure/health/sync-state`), enforced at the existing default-deny edge gate. It should:
   - never carry admin rights
   - be capped per user
   - have mint/revoke audited
   - have a bounded TTL, with rotation on use if background sync needs longevity
   - end on password change / sign-out-everywhere (or document clearly why it doesn't)
   - be **off by default** behind a config flag
3. **Remove `/api/auth/companion-session` from this work.** The "web UI inside the app" companion should get its own issue, as Scott already suggested.
4. **Fix the terminology** and add a snapshot test that checks every catalog code against a terminology source:
   - correct SNOMED sleep-stage codes, and remove `89129007` from the Awake aliases
   - don't code stages under `93832-4` "Sleep duration"
   - don't use `sleep` as an HL7 observation-category
   - use `59408-5` (with `2708-6`) for pulse oximetry
5. **Separate vendor systems and aliases.** HealthKit vs Health Connect coding systems, and numeric stage aliases per vendor.
6. **Blood pressure.** Merge components across batches by correlation id (update the existing row), and accept standalone systolic/diastolic Observations.
7. **Updates and deletes.** Upsert on `(user_id, identifier_system, external_uuid)` with a version/modified marker, and add a tombstone/delete path for HealthKit deletions and Health Connect changes.
8. **Timezones.** Keep each sample's UTC offset / tz, bucket days and nights in the patient's local time, and reject timestamps without an offset.
9. **De-duplicate cumulative metrics.** Either apply source priority / overlap handling server-side, or have companions send vendor-computed aggregates for steps.
10. **Scale.** Downsample in SQL for every mode, default or require a window, and consider a daily rollup table. Decide whether samples belong in a separate database file (see Q4).
11. **FHIR output.**
    - `meta.source` must be a URI, or drop it
    - no `Bundle.total` on `collection`
    - add a PGHD marker (performer → Patient and/or `meta.tag`)
    - keep the caller's `valueCodeableConcept` system
    - treat Device/DeviceMetric as a follow-up
12. **Input limits.** Per-metric value ranges, string length caps, a cap on `anchors`, and one transaction for the anchor upserts.
13. **Clean up.** Collapse to one migration with the final schema, remove the provider-side `ALTER`s, fix the failing spec and the ESLint error, and remove the `console.log` of the token.
14. **Split out unrelated changes:** Dockerfile/distroless, `angular.json`, header CSS, and the agent-token cleanup on account deletion (the last is a good fix on its own).
15. **Transport.** Don't derive `https` from `secure-cookies`, and document or require TLS for anything beyond explicit LAN opt-in.

## Suggested phasing (mergeable pieces)

1. **PR 1: storage and API, session-authenticated only.**
   - Contents: migration, `SqliteHealthProvider`, `HealthManager`, catalog, `toObservation`, and the `/api/secure/health/*` routes, with requested changes 4–13 applied.
   - Behind `yourphr.health.enabled` (default off).
   - Ingest works from the web session, which also covers #314's "Manual / CSV / JSON fallback" (upload an Apple Health / Health Connect export or a FHIR Bundle) without any new credential.
2. **PR 2: read UI.** The Health page, charts, dashboard tile, and visit summary (reviewed on its own; it's 4 k lines).
3. **PR 3: MCP bridge.** The `read_health_metric` tool and the `yourphr://health` resource, plus the `Health` access category. This already rides on agent tokens.
4. **PR 4: scoped ingest credential.** A short design note first, aligned with #695 and ngdpbase's agent-token/route-map model, then the implementation and pairing UI inside main's new Settings key screen.
5. **Separately:** companion apps in their own repo(s), with a license decision and a distribution plan. The WebView companion goes in its own issue.
6. **Separate small PRs:** Docker image slimming, and agent-token cleanup on account deletion.

## Open questions for Jim

1. Do you want companion mobile apps associated with yourPHR at all? If so: in this repo or separate, under what license, and who maintains them and pays for the developer accounts?
2. Should the ingest credential extend agent tokens with a first **write** scope (which revisits #695's "read-only first cut"), or be a separate token type with the same guarantees (scoped, capped, audited, expiring, off by default)?
3. Background sync wants a long-lived credential. Is a rotating credential (for example, a 30-day TTL renewed on each successful sync) acceptable, given that #719 removed "never expires"?
4. Should samples live in `spike.db` or in a separate encrypted database file? This affects backup size and the ngdpbase layout.
5. Timezone policy: a per-user timezone setting, or the per-sample offset?
6. Is "first Patient" acceptable for the first cut, given one account per household member, or should the account pick its Patient explicitly?
7. Should "Full export" include the wearable Bundle?
8. How to model sleep: stage intervals (a codeable value per interval), per-night stage durations (`93829-0` REM, `93830-8` light, `93831-6` deep, `93828-2` awakening), or both?
9. Is a light confirmation of contribution provenance (corporate email, a second author) worth asking for?

## Suggested reply to steglasaurous (draft, NOT posted)

> Hi Scott, thank you for this. It's a lot of careful work, and the proposal doc made it easy to follow. I read through the branch and ran it locally, and I'd like to take it. Here's the direction I'm hoping for:
>
> **What I'd love to merge first:** the samples store and API. Keeping wearable data out of the FHIRPath write path in dedicated tables behind `HealthManager`/`SqliteHealthProvider`, and rebuilding Observations on read, is the right call, and it fits how the rest of the server is built. Idempotency on the external id, per-account isolation, the Health access category and the tests are all what I'd want.
>
> **What I'd like to change before it lands:**
> - **Pairing credential.** Right now the device token acts as the whole account (on an admin account it can reach the admin screens and delete the account), `companion-session` can turn it into a normal session that mints more tokens, and it defaults to never expiring. On main, #695/#719 went the other way: tokens are scoped, capped, audited and always expire, and the old QR pairing screen and `/access/token` + `/sync/discovery` routes were removed on purpose. Could we make the phone credential a narrowly scoped one, ideally an agent-token-style key with a single "write health samples" scope that only reaches `POST /api/secure/health/samples` (plus sync-state)? Let's leave `companion-session` and the WebView companion for the separate issue you suggested.
> - **Sleep codes.** I checked the catalog against tx.fhir.org. Most of the SNOMED sleep-stage codes don't resolve (248218006, 248219008, 248218000), 248220008 is "Asleep" rather than deep sleep, and 89129007 (REM sleep) is in the Awake aliases. 93832-4 is "Sleep duration" rather than a stage, `sleep` isn't an HL7 observation-category code, and 59408-5 would be the pulse-ox code. Since these get stored, it'd be great to fix them before the first merge, maybe with a small test that checks the catalog codes.
> - **Sync edge cases:** blood-pressure halves arriving in different batches (the diastolic gets dropped as a duplicate), updates/deletions from HealthKit and Health Connect, keeping each sample's timezone offset so days and nights bucket locally (a Pacific-time night currently splits in two), steps from iPhone + Watch being summed twice, and Health Connect's numeric sleep stages (4 = LIGHT) colliding with HealthKit's.
>
> **Could you split it up?** Roughly: (1) storage + API + catalog behind a `yourphr.health.enabled` flag, with session-authenticated ingest (which also covers the CSV/JSON/FHIR-bundle upload path in #314); (2) the Health page and visit summary; (3) the MCP tool; (4) the scoped phone credential, after a short design note. The Dockerfile/distroless, `angular.json` and header CSS changes would be great as their own PRs, as would the agent-token cleanup on account deletion, which is a nice fix. The branch is about 145 commits behind main now and conflicts in 8 files, so a rebase first would help. CI currently fails at the route-contract step, and the discovery test depends on the machine's hostname.
>
> **The apps:** I couldn't find the iOS/Android source. Is it in another repo? I'd like to understand the license, where the token is stored, whether they use any third-party SDKs or analytics, and whether they talk plain HTTP on the LAN, before we point people at them. I'm happy to talk through how we'd distribute them.
>
> Thanks again. This is the feature I hoped someone would pick up, and you've done most of the hard thinking already.

## What I could not check

- The iOS and Android app source: not found in any public location I could see, so permissions, token storage, ATS/cleartext settings and SDKs/telemetry are all unreviewed.
- The full Angular test suite, full `ng lint` (including the Makefile badge check), the Storybook build, and a Docker image build and run.
- Real HealthKit / Health Connect payloads. The double-counting (M4) and update/delete behaviour (M2) come from reading the code, not from device data.
- Year-scale performance: measured at 1 M rows, extrapolated beyond that.
- Whether the lforms asset-glob change in `angular.json` breaks questionnaire rendering.
