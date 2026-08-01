# Vendors

Reference notes on the external health-IT vendors whose data and APIs YourPHR interoperates with. Each doc follows the same shape: **Overview · Ownership & History · Products · Contact · API & Integration · Known API Issues · Relevance to YourPHR · References**.

| Vendor | Doc | Why it matters to YourPHR |
|---|---|---|
| **FollowMyHealth** | [`followmyhealth.md`](./followmyhealth.md) | Patient portal; its FHIR R4 export is the primary real-world (non-US-Core) dataset YourPHR is hardened against. |
| **Veradigm** (formerly **Allscripts**) | [`veradigm-allscripts.md`](./veradigm-allscripts.md) | Owns FollowMyHealth and the SMART/FHIR developer program; the external gatekeeper for live sync ([#53](https://github.com/jwilleke/yourphr/issues/53)). |

Integration / topic notes (not vendor profiles): [`epic-sandbox.md`](./epic-sandbox.md) (connect to Epic's public SMART sandbox — the lowest-friction live target, [#257](https://github.com/jwilleke/yourphr/issues/257)) and [`clientid-friction.md`](./clientid-friction.md) (why obtaining a ClientID is the project's biggest blocker).

## Sandbox registration guides — where to register & what you need

How to obtain credentials for each test sandbox. The index with connect values + status is [`../testing-sandboxes/test-sandboxes.md`](../testing-sandboxes/test-sandboxes.md); actual credential values live in `private/secrets.md` (gitignored).

| Sandbox | Register at | What you get | Guide |
|---|---|---|---|
| **SMART Health IT** | _nothing — open sandbox_ | any `client_id`, no secret | [`smart-health-it.md`](./smart-health-it.md) |
| **CMS Blue Button 2.0** | <https://bluebutton.cms.gov/developers/> | `client_id` + `client_secret` (confidential) | [`medicare.md`](./medicare.md) |
| **Epic** | <https://fhir.epic.com> | `client_id` (public/PKCE) | [`epic-sandbox.md`](./epic-sandbox.md) |
| **FollowMyHealth / Veradigm** | <https://developer.veradigm.com> | `client_id` (public/PKCE) — ⛔ provisioning-gated | [`followmyhealth.md`](./followmyhealth.md) |
| **Oracle Health (Cerner)** | <https://code-console.cerner.com/> | `client_id` (public/PKCE), console-issued | [`oracle-cerner.md`](./oracle-cerner.md) |
| **athenahealth** | <https://mydata.athenahealth.com/access-the-apis> | `client_id` + `client_secret` (confidential / Web app) — approval-gated | [`athenahealth.md`](./athenahealth.md) |

See also: [`../FHIR/fhir-testing.md`](../FHIR/fhir-testing.md) (test-vs-real environments) and [`../FHIR/fhir-test-discovery-example.md`](../FHIR/fhir-test-discovery-example.md) (a captured FollowMyHealth discovery document).

## ⚠️ Everything below is SANDBOX

All credentials, endpoints, and test patients documented here and in `private/secrets.md` are **test/sandbox** — synthetic patients, no real PHI. **Production** registration for each vendor is a separate, later effort (different endpoints, real approval, real client_ids). Do not mix the two: the provider catalog separates them by `Environment` (`sandbox` vs `production`).

## How each sandbox operates + live connect status

_Last full retest of status rows: **2026-07-31** (demo.yourphr.org + yourphr.nerdsbythehour.com). Prior matrix pass: 2026-06-18._

YourPHR connects to all of these the same way: a one-click button on **`/sandbox`** runs the SMART-on-FHIR flow (server-side `client_id`/secret, PKCE, our relay catches the redirect). What differs per vendor is the auth model and how gated record access is.

| Sandbox | Auth model | Test patient | Live status |
|---|---|---|---|
| **CMS Blue Button 2.0** | confidential (id+secret) | synthetic Medicare beneficiary (`BBUser00000` / `PW00000!`) | ⛔ **sandbox login broken (2026-07-31)** — OAuth authorize reaches CMS; synthetic + ID.me paths fail before any auth code (see [`medicare.md`](./medicare.md)). Was ✅ E2E 2026-06-14. |
| **Epic** | public / PKCE | sandbox test patients (e.g. Camila Lopez) | ✅ **E2E verified 2026-07-31** on production (also 2026-06-18); skips some 403/400 types; watch **offline refresh token** after connect ([`epic-sandbox.md`](./epic-sandbox.md)) |
| **SMART Health IT** | open (any `client_id`, no secret) | pick at launcher | ✅ **E2E verified 2026-07-31** on demo.yourphr.org (~455 KB export) |
| **athenahealth** | confidential (id+secret) | `phrtest_preview@mailinator.com` / `Password1` (also `athenainterop@aol.com`) | 🟡 **auth works** (2026-06-18); patient login works; record-sharing **gated** on app onboarding/provisioning in the Developer Portal |
| **Oracle Health (Cerner)** | public / PKCE | `nancysmart` / `Cerner01` | 🟡 **partial** — connect works; large patients can **page-cap abort** (~1000 pages) and leave **no Patient** → UI Failed (**2026-07-31**, [#439](https://github.com/jwilleke/yourphr/issues/439)). Needs pinned authorize + enumerated v2 `.rs` + Offline (see below) |
| **Veradigm / FollowMyHealth** | public / PKCE | Veradigm test org | ⛔ **blocked** (`unauthorized_client`, ticket #17849 / [#53](https://github.com/jwilleke/yourphr/issues/53)) — unchanged |

### Per-vendor operating notes

- **Blue Button** — pure OAuth2; confidential client; restricted scopes (no wildcard / `offline_access`). **Do not treat as the reliable smoke test right now:** as of **2026-07-31** the CMS sandbox beneficiary login and ID.me synthetic path both fail on CMS's side (same on demo + prod). Full connect guide: [`../medicare-bluebutton.md`](../medicare-bluebutton.md); registration: [`medicare.md`](./medicare.md).
- **Epic** — public/PKCE patient app; advertises ~100 resource types but **403/400s** several (AdverseEvent 403, CarePlan "requires category" 400). YourPHR skips inaccessible types so the rest import. ([`epic-sandbox.md`](./epic-sandbox.md))
- **SMART Health IT** — open reference launcher; needs the long `/sim/<base64>/fhir` base; accepts any `client_id`; lets you pick a synthetic patient. **Best smoke test while Blue Button sandbox login is broken.** Live E2E on demo 2026-07-31. ([`smart-health-it.md`](./smart-health-it.md))
- **athenahealth** — confidential ("Web") app; **approval-gated**. OAuth + patient login succeed, but the patient record-sharing step ("Could not confirm access to additional health records") needs the app fully onboarded in the Developer Portal. Not a YourPHR bug. Live note dated **2026-06-18**. ([`athenahealth.md`](./athenahealth.md))
- **Oracle/Cerner** — public/PKCE, **hardest sandbox**. Four auth obstacles solved ([#338](https://github.com/jwilleke/yourphr/issues/338)): (1) patient authorize not discoverable → pin override; (2) SMART v2 app / smart-v1 endpoints only; (3) enumerate v2 `.rs` scopes; (4) Offline for refresh. Base/`aud` = `fhir-ehr.cerner.com`. Slow/flaky (~57 s 504s). **Open:** global 1000-page fetch cap aborts remaining types (incl. Patient) on large sandbox patients — UI Failed (**2026-07-31**, [#439](https://github.com/jwilleke/yourphr/issues/439)). Full guide: ([`oracle-cerner.md`](./oracle-cerner.md)).
- **Veradigm / FollowMyHealth** — discovery + authorize start; login returns `unauthorized_client` until Veradigm provisions the app. Manual FHIR/EHI upload remains the import path. ([`followmyhealth.md`](./followmyhealth.md), [`veradigm-allscripts.md`](./veradigm-allscripts.md))
