# Production onboarding log

What it took, vendor by vendor, to get yourPHR from a working sandbox to __real patients at real organizations__. The sandbox guides (`epic-sandbox.md`, `oracle-cerner.md` and the rest) explain how to connect; this file records the production process itself: each step, when it happened, what blocked it, and what we would do differently. Add to it as things happen, newest last within each vendor, with the date and the issue.

Why it matters: getting a production client ID is the project's biggest blocker ([`clientid-friction.md`](./clientid-friction.md)), and each vendor's process is learned the hard way once. Writing it down is how the second time is quick.

## Status

| Vendor | Production state | Blocked on | Tracking |
|---|---|---|---|
| __Epic__ | App 56252 Ready for Production, 519 organizations requested it; __syncing paused by Epic__ | Epic removing 10 non-USCDI-v3 APIs (list is locked to us) | [#863](https://github.com/jwilleke/yourphr/issues/863), [#408](https://github.com/jwilleke/yourphr/issues/408) |
| __CMS Blue Button__ | Runbook written; see it for the current step | CMS production access process | [`../cms-bluebutton-production-access.md`](../cms-bluebutton-production-access.md), [#433](https://github.com/jwilleke/yourphr/issues/433) |
| __athenahealth__ | Sandbox only; record sharing gated on portal onboarding | Developer Portal approval | [#339](https://github.com/jwilleke/yourphr/issues/339) |
| __Oracle Health (Cerner)__ | Sandbox only (partial) | not started | [`oracle-cerner.md`](./oracle-cerner.md) |
| __Veradigm / FollowMyHealth__ | Sandbox `unauthorized_client` until Veradigm provisions the app | Veradigm | [#53](https://github.com/jwilleke/yourphr/issues/53) |

## Epic — app 56252 (YourPHR)

### Lessons

- __Select only APIs from the USCDI v3 appendix before marking Ready for Production.__ Automatic client distribution, the only realistic path to "a patient connects her own MyChart", requires every selected API to be on that list (*Patient-Facing Apps Using FHIR* → Appendix). One stray API pauses every organization.
- __Once released, the Incoming APIs list is locked.__ The Build Apps page's Edit button then unlocks only redirect URIs, JWK Set URLs and descriptive text. Removing an API needs Epic, or a new app. Epic's own guidance: "you can always create a new client ID to enable additional APIs", so start narrow.
- __A refresh-token (confidential, persistent access) app needs a client credential uploaded per organization__ before it auto-distributes there.
- __The app page and the appendix name some APIs differently__ (Generated CDAs vs Generated CCDA, Vital Signs vs Vitals, Encounter vs Encounter-Level). Compare on resource, operation, version and variant, not on exact text.
- An app with __0 production downloads can still be deactivated__ by the developer, so a replacement app is possible if Epic will not edit the old one.

### Log

| Date | What happened |
|---|---|
| 2026-06-15 → 2026-08-01 | Sandbox: discovery, then end-to-end connect and import verified on production hosts ([`epic-sandbox.md`](./epic-sandbox.md#live-connect-log-dated)). |
| 2026-08-19 | App made a __confidential client with persistent access__ (Epic issues no refresh tokens to public standalone clients); refresh tokens proven in sandbox. Marked __Ready for Production__ with Automatic Client Distribution = USCDI v3. |
| by 2026-09-27 | __519 organizations__ requested the app through automatic distribution; every one shows "Syncing to Production has been temporarily disabled for this customer by Epic while your app is modified". Client ID downloads: 0. |
| 2026-09-27 | Asked <open@epic.com> what modification Epic is waiting on, and whether per-organization activation with a client secret is the next step. |
| 2026-10-02 | Epic (Hunter): the app "has many APIs outside the scope of USCDI v3 automatic client distribution"; it may use only the appendix APIs. Filed [#863](https://github.com/jwilleke/yourphr/issues/863) (P0). |
| 2026-10-07 | Compared the app's 245 selected APIs with the appendix: __10 do not qualify__, none of which yourPHR uses — ExplanationOfBenefit (Claim), and the Outside Record variants of QuestionnaireResponse, Organization, Practitioner, RelatedPerson and ServiceRequest (Read and Search each, R4). The list is locked on a released app, so asked Epic to remove them or unlock it, and repeated the per-organization credential question. |
| 2026-10-07 | Sandbox re-verified end to end on v3 (prod host, test account): 310 records imported. Found and fixed on the way: no relay configured on v3 ([#870](https://github.com/jwilleke/yourphr/issues/870)), and no client secret in the Epic catalog entry ([#871](https://github.com/jwilleke/yourphr/issues/871)). __Both would also have blocked production__, even after Epic lifts the hold. |

### Next

1. Epic removes the 10 APIs (or says to build a new app; fallback below).
2. Syncing resumes; upload a client credential for Licking Memorial Health Systems (organization 9332) first.
3. A real patient connects her own MyChart end to end ([#408](https://github.com/jwilleke/yourphr/issues/408)).

Fallback if Epic will not edit 56252: a new app with only qualifying APIs, USCDI v3, confidential with persistent access, the same redirect URI and text; mark it Ready for Production; deactivate 56252 (0 downloads); update yourPHR's Epic catalog entry and secret.
