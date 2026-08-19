# Epic SMART on FHIR Sandbox

Connect YourPHR to Epic's **public SMART on FHIR sandbox** to exercise the full
patient standalone launch (authorize → login → token exchange → import) with
**synthetic patients and zero PHI**. Unlike a real provider, Epic lets you
self-register a patient-facing app and get a non-production `client_id`
immediately — **no vendor approval gate**. This makes Epic the lowest-friction
way for a new contributor to validate live SMART sync end-to-end, directly
serving the mission of immediate patient access ([#15](https://github.com/jwilleke/yourphr/issues/15)).

This work is tracked by [#257](https://github.com/jwilleke/yourphr/issues/257)
and rides on the now-complete SMART on FHIR stack ([EPIC #20](https://github.com/jwilleke/yourphr/issues/20)).

**Register at:** <https://fhir.epic.com> — self-register a patient-facing app to get a non-production `client_id`; no approval gate. Save it to `private/secrets.md`.

> **Confidential client since 2026-08-19.** Epic never issues refresh tokens to public standalone clients — their offline-access path for public apps is dynamic client registration, which YourPHR does not implement. The YourPHR app registration therefore has **"Is Confidential Client"** and **"Requires Persistent Access"** checked, with a website-generated **Sandbox Client Secret** (plaintext in `private/secrets.md`, hash stored at Epic). The instance supplies it via `YOURPHR_SANDBOX_EPIC_CLIENT_SECRET`; the Go client then authenticates `client_secret_basic` and Epic returns a `refresh_token`. This ended the 2026-07-31 "access token expired and no refresh token is available" cycle.

## Status at a glance

- **Is anything blocking Epic? No.** Epic's sandbox is self-service — register a
  patient-facing app, get a non-production `client_id`, run the flow. There is
  no approval gate. (That gate is Veradigm-specific, [#53](https://github.com/jwilleke/yourphr/issues/53) — see below.)
- **Epic sandbox E2E is verified** on production (see [Live connect log](#live-connect-log-dated) below). Same generic SMART-R4 client as SMART Health IT ([#48](https://github.com/jwilleke/yourphr/issues/48)–[#52](https://github.com/jwilleke/yourphr/issues/52)); catalog one-click path is live on `/web/sandbox`.
- **Supporting stack — DONE**: SMART spike ([#48](https://github.com/jwilleke/yourphr/issues/48)), generic client ([#49](https://github.com/jwilleke/yourphr/issues/49)), relay ([#50](https://github.com/jwilleke/yourphr/issues/50)), backend OAuth ([#51](https://github.com/jwilleke/yourphr/issues/51)), connect UI ([#52](https://github.com/jwilleke/yourphr/issues/52)), sandbox pre-fill / this guide ([#257](https://github.com/jwilleke/yourphr/issues/257) / PR [#260](https://github.com/jwilleke/yourphr/pull/260)).

### Live connect log (dated)

| Date | Host | Result |
|---|---|---|
| **2026-06-15** | discovery only | ✅ `.well-known/smart-configuration` **200**, PKCE `S256`, `launch-standalone` + `client-public` + `context-standalone-patient` + `permission-offline` |
| **2026-06-18** | production matrix | ✅ **works** — imports records; skips types Epic **403/400**s (e.g. AdverseEvent 403, CarePlan “requires category” 400) |
| **2026-07-31** | **yourphr.nerdsbythehour.com** `/web/sandbox` | ✅ **E2E connect + import** — authorize/connect **200** (~11 s connect); per-resource SMART walk ~**4 min** for first pass; Patient stored (UUID). Brief UI 500 on Patient while first pages were still writing (race); later loads **200**. |
| **2026-08-01** | same host, Sources recheck | ✅ Patient `GET` **200** for Epic sources; imported data still present |

#### 2026-07-31 production notes (detail)

- Catalog entry authorize `POST …/provider-catalog/fbf29bef-…/authorize` **200** at **14:00:49Z**; connect **200** at **14:01:00Z** (latency ~11 s). Second Epic-path catalog connect **14:22:20Z** also completed a short type walk.
- Import path: `no Patient/$everything` → per-resource compartment search. Many empty/403 types skipped gracefully; usable clinical types + Patient imported.
- **AuditEvent / Communication / Task:** log noise `error upserting … Invalid resource type for model: AuditEvent` (and similar) — fetch succeeds, **DB model missing** for those types; not fatal to the rest of the import.
- **Token refresh (ongoing after connect):** source `bb1dbc09-…` (Epic sandbox, user `jwilleke`) logs every ~30 min:

  ```text
  token-refresh: source bb1dbc09-…: access token expired and no refresh token is available; reconnect the source
  ```

  Access token dies; **no `refresh_token` stored**. Other sources on the same host still refresh (`attempted N, refreshed M` with M≥1). Ensure the Epic app grants **offline** / `offline_access` (scopes table below already request it) and reconnect once so a refresh token is issued — otherwise re-sync / scheduled refresh will fail until the user reconnects. Contrast Oracle Challenge 4 / Offline app type in [`oracle-cerner.md`](./oracle-cerner.md).

- **Not the multi-hour hang:** wall clock for Epic was minutes; the long 2026-07-31 download was **Oracle** ([#439](https://github.com/jwilleke/yourphr/issues/439)).

## Why Epic (vs. Veradigm)

- Epic's **sandbox** issues a non-production `client_id` on self-registration —
  immediate, no approval.
- Veradigm/FollowMyHealth ([#53](https://github.com/jwilleke/yourphr/issues/53))
  requires registration **and vendor approval** before issuing a `client_id`,
  which is why it is `blocked`. Epic is therefore the better *first* live target,
  even though Veradigm is the primary real-world dataset YourPHR is hardened
  against (see [`followmyhealth.md`](./followmyhealth.md)).
- Broader friction context: [`clientid-friction.md`](./clientid-friction.md).

## How the pieces fit

- YourPHR uses **per-user / bring-your-own `client_id`**: you register your own
  patient-facing app at Epic and paste its `client_id` into the connect modal.
  YourPHR never holds a shared credential.
- After login, Epic redirects the browser to a **public relay** that only
  bounces the short-lived authorization `code` (never tokens). The default is
  `https://relay.nerdsbythehour.com`; override with `YOURPHR_RELAY_PUBLIC_URL`
  (the origin the provider redirects to) plus `YOURPHR_RELAY_URL` /
  `YOURPHR_RELAY_SECRET` (where the backend polls). No frontend rebuild is
  needed — see [`../../backend/cmd/relay/README.md`](../../backend/cmd/relay/README.md).
- The redirect URI registered with Epic must **exactly** match the relay
  callback: `https://relay.nerdsbythehour.com/callback` (or your own relay's
  `/callback`).

## How to connect

### Prerequisites

- A running YourPHR instance (dev: `make serve-backend` + `make serve-frontend`).
- A free Epic developer account at <https://fhir.epic.com>.
- Browser popups allowed for your YourPHR origin (login opens in a popup).

### Step 1 — Register a patient-facing app at Epic

- Sign in at <https://fhir.epic.com> and open **Build Apps → Create**.
- Choose **Patients** as the audience (patient standalone launch).
- Set the application's **Redirect URI** to your relay callback:
  - Default project relay: `https://relay.nerdsbythehour.com/callback`
  - Self-hosted relay: `https://<your-relay-host>/callback`
- Select the FHIR R4 APIs you want (e.g. Patient, AllergyIntolerance,
  Condition, MedicationRequest, Observation, DocumentReference). Sticking to
  US Core resources keeps you eligible for Automatic Client ID Distribution
  later (see [`clientid-friction.md`](./clientid-friction.md)).
- Save. Epic issues a **Non-Production Client ID** immediately — copy it.

### Step 2 — Connect from YourPHR

- Open **Medical Sources** in the app.
- Under **Connect a SMART source**, click **Use Epic Sandbox**. This pre-fills
  the FHIR base URL and scopes for Epic's sandbox.
- Paste your **Non-Production Client ID** from Step 1 into the **Client ID** field.
- Click **Connect**. A popup opens to Epic's login.

### Step 3 — Log in as a synthetic test patient

- In the popup, log in with one of Epic's published sandbox test patients.
- Epic maintains the canonical, current list (usernames, passwords, and the
  data each patient has) at:
  <https://fhir.epic.com/Documentation?docId=testpatients>
- A commonly used example is **Camila Lopez** (the same synthetic patient
  backing the `backend/pkg/database/testdata/epic_fhircamila.ndjson` fixture).
- Approve the requested scopes. The popup returns to the relay, YourPHR
  exchanges the code for tokens, and the import starts. Progress appears on the
  **Connected Sources** list.

## Reference — Epic sandbox values

These are the values the **Use Epic Sandbox** button pre-fills. They are public,
non-secret sandbox endpoints — the only thing you supply is your own `client_id`.

| Field          | Value                                                                   |
| -------------- | ----------------------------------------------------------------------- |
| FHIR base URL  | `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4`             |
| Authorize      | `https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize`        |
| Token          | `https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token`            |
| Scopes         | `launch/patient patient/*.read openid fhirUser offline_access`          |
| Redirect URI   | `https://relay.nerdsbythehour.com/callback` (or your self-hosted relay) |
| Client ID      | your Non-Production Client ID from Step 1 (BYO — not shared)             |

YourPHR discovers the authorize/token endpoints automatically from
`{FHIR base}/.well-known/smart-configuration`, so you only need the FHIR base
URL, scopes, and your `client_id`.

## What's next on Epic sandbox

**First production E2E is done** (see [Live connect log](#live-connect-log-dated)). Remaining polish:

- Confirm every sandbox Epic app registration includes **offline access** so `offline_access` actually yields a refresh token (see 2026-07-31 token-refresh note).
- Optionally skip or model unsupported types that spam upsert warnings (`AuditEvent`, etc.).
- Re-verify US Core display for Camila Lopez / current test patients after import; file display gaps separately ([#54](https://github.com/jwilleke/yourphr/issues/54) closed).
- Close or update tracking [#257](https://github.com/jwilleke/yourphr/issues/257) if the original “first connection” acceptance is satisfied.

Deliberately **out of scope**: a fully automated CI E2E against the sandbox —
Epic's login is interactive, so automating it is brittle. This manual procedure
is the supported verification path.

## Troubleshooting

- **"Browser blocked the login popup."** Allow popups for the YourPHR origin and
  click **Connect** again (the popup is opened in the click handler, so it must
  not be blocked).
- **`redirect_uri` mismatch / invalid redirect at Epic.** The URI registered in
  Step 1 must match the relay callback **character-for-character**, including
  scheme and path. Confirm whether your instance uses the default relay or a
  self-hosted one (`YOURPHR_RELAY_URL`).
- **"Connection failed … complete the login and try again."** The backend polls
  the relay for the code (login wait is configurable; default is minutes, not
  30s). If login took longer, retry **Connect** after finishing the Epic login.
- **No data after connecting.** Pick a test patient that actually has the
  resource types you selected in Step 1 (the test-patient page lists each
  patient's data).
- **Patient 500 for a few seconds right after Connect.** UI may request
  `Patient/{id}` before the first upsert lands — transient; refresh. (Not the
  Oracle missing-Patient case [#439](https://github.com/jwilleke/yourphr/issues/439).)
- **`token-refresh: … no refresh token is available`.** Epic access token
  expired and no refresh was stored. Reconnect after confirming the app allows
  offline / `offline_access`. Imported FHIR data remains; only live re-sync
  needs a new login.
- **Log spam `Invalid resource type for model: AuditEvent` (etc.).** Epic
  returned a type YourPHR has no GORM model for; those rows are dropped, other
  types continue.

## References

- Mission: [#15](https://github.com/jwilleke/yourphr/issues/15) (21st Century Cures Act — immediate patient access).
- This feature: [#257](https://github.com/jwilleke/yourphr/issues/257); PR [#260](https://github.com/jwilleke/yourphr/pull/260).
- SMART on FHIR umbrella: [EPIC #20](https://github.com/jwilleke/yourphr/issues/20) — children [#48](https://github.com/jwilleke/yourphr/issues/48), [#49](https://github.com/jwilleke/yourphr/issues/49), [#50](https://github.com/jwilleke/yourphr/issues/50), [#51](https://github.com/jwilleke/yourphr/issues/51), [#52](https://github.com/jwilleke/yourphr/issues/52), [#53](https://github.com/jwilleke/yourphr/issues/53), [#54](https://github.com/jwilleke/yourphr/issues/54).
- Design: [`../planning/smart-on-fhir/smart-on-fhir.md`](../planning/smart-on-fhir/smart-on-fhir.md), [`../planning/smart-on-fhir/oauth-gateway.md`](../planning/smart-on-fhir/oauth-gateway.md).
- Friction notes: [`clientid-friction.md`](./clientid-friction.md).
- Epic docs: SMART test patients <https://fhir.epic.com/Documentation?docId=testpatients>; OAuth2 <https://fhir.epic.com/Documentation?docId=oauth2>.
- [Epic Developer Docs](https://fhir.epic.com/Documentation?docId=developerguidelines)
