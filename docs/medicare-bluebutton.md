# Connect Medicare — CMS Blue Button 2.0

How to connect **CMS Blue Button 2.0** (Medicare claims data) to YourPHR as a SMART-on-FHIR source — **sandbox** (verified) and **production** (after CMS credentials).

**Related:** [provider catalog](provider-catalog/README.md) · [connection policy](connection-policy.md) · [attributions](Attributions.md) · [#432](https://github.com/jwilleke/yourphr/issues/432) · [#408](https://github.com/jwilleke/yourphr/issues/408)

## Patient-facing name: “Medicare” (#429)

Blue Button is the API / architecture (FHIR, OAuth, CARIN). For CMS production-access UI rules, when enrollees pick among several sources the **list label must be “Medicare”** — not “Blue Button”, “CMS Blue Button”, or “Medicare.gov”.

YourPHR enforces that on the **production** connectable list and when storing the connected source display. **Sandbox / admin** may keep explicit names (e.g. `Medicare — Blue Button 2.0 (Sandbox)`). Attributions still say “Blue Button APIs” where required ([#428](https://github.com/jwilleke/yourphr/issues/428)).

## What Blue Button 2.0 gives you

A national **FHIR R4** API for Medicare beneficiaries. Claims/insurance data: **`ExplanationOfBenefit`**, **`Coverage`**, **`Patient`**. Complementary to clinical EHR records, not a replacement.

| | Sandbox | Production |
|---|---|---|
| FHIR base | `https://sandbox.bluebutton.cms.gov/v2/fhir` | `https://api.bluebutton.cms.gov/v2/fhir` |
| Data | Synthetic beneficiaries | Real enrollee claims (with consent) |
| Credentials | Self-serve developer portal | CMS production-access review ([#433](https://github.com/jwilleke/yourphr/issues/433)) |
| YourPHR path | Admin `/sandbox` (env-seeded) | Patient `/sources` (catalog `environment=production`) |

> **Sandbox status:** ✅ E2E verified **2026-06-14** (login → token → sync). ⛔ **Regressed 2026-07-31**, **reconfirmed 2026-08-01** on demo.yourphr.org v1.19.1 — CMS synthetic beneficiary login (`BBUser00000` / `PW00000!`) shows *"We can't process your request at this time"*; no auth code reaches the relay (not a YourPHR callback bug). Details: [`vendors/medicare.md`](vendors/medicare.md). Use SMART Health IT for smoke tests until CMS restores sandbox login.

---

## Scopes (sandbox and production)

Use **exactly** (also `models.BlueButtonSMARTScopes`):

```
openid profile launch/patient patient/Patient.read patient/Coverage.read patient/ExplanationOfBenefit.read
```

**Do not** request (Blue Button returns `invalid_scope`):

- `patient/*.read` (no wildcard)
- `fhirUser`
- `offline_access` (sandbox rejects it; no refresh token → re-login for later re-sync)

---

## Sandbox (operators / developers)

### 1. Register a sandbox app

1. [CMS Blue Button developers](https://bluebutton.cms.gov/developers/) → **Sandbox**.
2. Register an application:

   | App setting | Value |
   |---|---|
   | **OAuth Client Type** | **`confidential`** |
   | **OAuth Grant Type** | **`authorization-code`** |
   | **Callback URL / Redirect URI** | **Exactly** this instance’s relay callback (see [Relay callback](#b-relay-callback-uri) below) |
   | **Collect beneficiary demographic data** | **Yes** |

3. Use the **Sandbox** `client_id` / `client_secret` (not Production).

### 2. Wire YourPHR (preferred: env seed)

Set on the app deployment (never commit secrets):

```bash
YOURPHR_SANDBOX_BLUEBUTTON_CLIENT_ID=…
YOURPHR_SANDBOX_BLUEBUTTON_CLIENT_SECRET=…
# Plus relay — see Relay callback
YOURPHR_RELAY_PUBLIC_URL=https://your-public-relay.example
YOURPHR_RELAY_SECRET=…   # same secret as the relay process
```

On startup, YourPHR upserts **Medicare — Blue Button 2.0 (Sandbox)** as `environment=sandbox`, enabled. Test from Admin → **Sandbox**, not patient Sources.

### 3. Alternate: Admin catalog

Admin → Provider Catalog: create/edit the sandbox Blue Button row (or env-seeded row), confidential secret, enabled. Connect from `/sandbox`.

### 4. Client id `/` gotcha

CMS portal may show `client_id/client_secret` as one string. Put **only** the id in Client ID and the secret in Client Secret — never paste both into Client ID.

### Sandbox troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `invalid_client` / Application does not exist | Wrong id, Production id on sandbox, or id+secret jammed into Client ID | Sandbox id only in Client ID; secret separate |
| `invalid_scope` | Wildcard / `fhirUser` / `offline_access` | Use exact scopes above |
| Relay timeout + popup “Connected” | Login longer than connect wait | Raise `YOURPHR_WEB_SMART_CONNECT_LOGIN_WAIT_SECONDS` (default 240); or pre-login at CMS |
| Relay timeout, no “Connected” | Redirect URI mismatch or incomplete login | Callback must match [Relay callback](#b-relay-callback-uri) exactly |
| CMS “We can't process your request at this time” on `BBUser…` login (**2026-07-31**, **2026-08-01** demo) | CMS sandbox synthetic login broken/changed; authorize never yields a code | Vendor-side — not a YourPHR callback bug. See [`vendors/medicare.md`](vendors/medicare.md); use SMART Health IT for E2E; watch CMS sandbox docs / [BlueButtonAPI@cms.hhs.gov](mailto:BlueButtonAPI@cms.hhs.gov) |
| ID.me / medicare.gov “patient data not found” (sandbox) | Sandbox has no real Medicare identity | Expected for synthetic path; do not use ID.me for BB sandbox |

---

## Production (#432) — operator checklist

**Goal:** After CMS issues production credentials, enable patient **Medicare** on `/sources` with **no code change** and **no secrets in git**.

### A. CMS production app

1. Complete CMS [production access](https://bluebutton.cms.gov/production-access/) process (privacy, terms, demo — [#433](https://github.com/jwilleke/yourphr/issues/433)).
2. Register **production** app with:
   - Confidential client, authorization-code
   - **Callback URL** = this instance’s relay callback ([below](#b-relay-callback-uri)) — **exact match**
   - Demographic collection as required by your CMS registration
3. Receive **Production** `client_id` and `client_secret` only via CMS (not the sandbox pair).

### B. Relay callback URI

1. As admin, open **Admin Dashboard → SMART OAuth Relay** (or `GET /api/secure/source/relay-config`).
2. Copy **`callback_url`** (public origin + `/callback`).
3. Register that **exact** string with CMS (sandbox app and/or production app).
4. Ensure `YOURPHR_RELAY_PUBLIC_URL` (and `YOURPHR_RELAY_URL` / `YOURPHR_RELAY_SECRET` as needed) match how you deploy the relay. See [`deployment/README.md`](deployment/README.md) and [`SMART-flow-map.md`](SMART-flow-map.md).

### C. Production catalog entry (no code change)

YourPHR ships a **credential-free production template** (migration):

| Field | Value |
|---|---|
| Display (admin) | `Medicare` |
| Environment | `production` |
| FHIR base | `https://api.bluebutton.cms.gov/v2/fhir` |
| Scopes | Blue Button SMART scopes above |
| Enabled | `false` until you add creds |
| Patient button label | **Medicare** (enforced) |

#### Option 1 — Admin UI (any host)

1. Admin → **Provider Catalog**
2. Open entry **Medicare** (or create with the values above if missing)
3. Set **Client ID** / **Client Secret** (production pair)
4. Set **Enabled** = true
5. Save

#### Option 2 — Env seed (GitOps / k8s Secret)

```bash
YOURPHR_PROD_BLUEBUTTON_CLIENT_ID=…
YOURPHR_PROD_BLUEBUTTON_CLIENT_SECRET=…
```

On startup, YourPHR upserts the production **Medicare** entry with those credentials and **enables** it. Restart the app after setting env.

Never commit these values. Prefer a sealed Secret / external secret store.

### D. Enrollee path (verify)

1. User grants PP/ToS on **Account Profile**
2. **Sources** → **Medicare** (not “Blue Button”)
3. Pre-connect informed modal → Continue
4. CMS login → Authorize → import on Connected Sources
5. Disconnect / Remove data / combined teardown work from Connected Sources (#437)

### E. Operator contact (optional but useful for demos)

Admin → **Instance** card: operator name / contact email / help URL for this deployment (not the OSS project). Enrollee-facing display of that contact may still be expanded later.

---

## How this maps to YourPHR internals

- **Catalog path** — patient and sandbox UIs use provider-catalog authorize/connect (not BYO form for normal use).
- **Discovery + PKCE** — `/.well-known/smart-configuration`; generic SMART client.
- **Confidential client** — [#286](https://github.com/jwilleke/yourphr/issues/286).
- **No `$everything`** — per-resource fetch ([#250](https://github.com/jwilleke/yourphr/issues/250)).
- **Patient id** — may come from Coverage/EOB when token omits `patient` ([#293](https://github.com/jwilleke/yourphr/issues/293)).
- **Connection policy** — PP/ToS + pre-connect modal ([connection-policy.md](connection-policy.md)).

## Related code / constants

| Item | Location |
|---|---|
| Sandbox seeds | `models.SandboxProviderSeeds()` + `YOURPHR_SANDBOX_BLUEBUTTON_*` |
| Production template | `models.ProductionMedicareCatalogTemplate()` |
| Production env seed | `database.SeedProductionMedicareProvider` + `YOURPHR_PROD_BLUEBUTTON_*` |
| Scopes constant | `models.BlueButtonSMARTScopes` |
