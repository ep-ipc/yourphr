# CMS Blue Button 2.0 — sandbox registration

How to get sandbox credentials for **CMS Blue Button 2.0** (Medicare claims). This is the **registration / credentials** guide; the full connect walkthrough, quirks, and troubleshooting live in [`../medicare-bluebutton.md`](../medicare-bluebutton.md).

**Register at:** <https://bluebutton.cms.gov/developers/> → **Sandbox** (free developer account; register a confidential app for a `client_id` + `client_secret`).

## Live connect status (dated)

| Date | Hosts | Result |
|---|---|---|
| **2026-06-14** | production YourPHR (nerdsbythehour) | ✅ **E2E verified** — synthetic login `BBUser00000` / `PW00000!` → token → sync (claims/coverage) |
| **2026-06-18** | sandbox matrix | ✅ still listed green in vendor matrix |
| **2026-07-31** | **demo.yourphr.org** and **yourphr.nerdsbythehour.com** | ⛔ **sandbox beneficiary login fails on CMS side** (see below). YourPHR OAuth start + relay poll behave as designed; no auth code is ever posted. |

### Failure detail — 2026-07-31 (CMS sandbox login)

Retested the **sandbox** Blue Button catalog entry on both demo and prod. Same symptoms on both instances (so not a single-host config/relay bug):

| Step | What happened |
|---|---|
| Authorize | CMS authorize page loads (200); YourPHR opens the popup and polls the relay |
| Synthetic login `BBUser00000` / `PW00000!` | CMS UI: **"can't process request"** (or equivalent) — never completes authorize |
| Alternate path (ID.me / medicare.gov chooser) | Fails with **patient data not found** (synthetic sandbox has no real Medicare identity) |
| After ~55s | Connect returns **502** / relay timeout; relay logs provider **`not_found`** (no code stored). Cloudflare may surface the 502 as a generic connect error |

**Interpretation:** Our client_id, scopes, and relay callback are fine enough to reach CMS login. The **CMS sandbox synthetic login path itself is failing** (or has changed in a way that breaks the published `BBUser`/`PW…!` credentials). Until CMS restores sandbox login (or documents a new synthetic path), use **SMART Health IT** for E2E smoke tests ([`smart-health-it.md`](./smart-health-it.md)). Production Medicare still needs CMS production credentials ([#433](https://github.com/jwilleke/yourphr/issues/433), [#408](https://github.com/jwilleke/yourphr/issues/408)).

## What you need

| Item | How |
|---|---|
| **Developer account** | free, at `bluebutton.cms.gov/developers` → Sandbox |
| **`client_id` + `client_secret`** | issued when you register a **confidential** sandbox app |
| **Synthetic beneficiary login** | `BBUser00000` / `PW00000!` (range `BBUser00000`–`BBUser29999`, password `PW<digits>!`) — **worked 2026-06-14; failing as of 2026-07-31** |

Blue Button is a **confidential** client (unlike the others here) — you get _and must use_ a `client_secret`. Save both to `private/secrets.md`.

## Steps

1. Go to **<https://bluebutton.cms.gov/developers/>** → **Sandbox** → create a developer account.
2. **Register an application**:

   | App setting | Value |
   |---|---|
   | **OAuth Client Type** | `confidential` (gives `client_id` **and** `client_secret`) |
   | **OAuth Grant Type** | `authorization-code` |
   | **Callback / Redirect URI** | this instance’s relay callback (e.g. `https://relay.nerdsbythehour.com/callback` or `https://demo-relay.yourphr.org/callback`) — **exact match** |
   | **Collect beneficiary demographic data** | Yes (else `GET /Patient` returns 401) |

3. Save the **Sandbox** `client_id` + `client_secret` to `private/secrets.md`.

## Connect values

| Field | Value |
|---|---|
| **FHIR base URL** | `https://sandbox.bluebutton.cms.gov/v2/fhir` |
| **Client ID / Secret** | your sandbox pair |
| **Scopes** | `openid profile launch/patient patient/Patient.read patient/Coverage.read patient/ExplanationOfBenefit.read` (no wildcard / `fhirUser` / `offline_access`) |

## Production (real Medicare data)

A separate CMS **production** app-review (no cost); the base becomes `https://api.bluebutton.cms.gov/v2/fhir` and you use the Production `client_id` / `client_secret`.

## See also

- **Full connect guide + troubleshooting:** [`../medicare-bluebutton.md`](../medicare-bluebutton.md)
- Index: [`../testing-sandboxes/test-sandboxes.md`](../testing-sandboxes/test-sandboxes.md)
- Vendor matrix: [`README.md`](./README.md)
