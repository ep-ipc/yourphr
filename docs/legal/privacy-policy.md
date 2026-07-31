# Privacy Policy — YourPHR

**Public URL:** [https://yourphr.org/privacy.html](https://yourphr.org/privacy.html)  
**Source:** this file. Update `gh-pages` `privacy.html` when you change it.  
**Related:** [Terms of Service](terms-of-service.md) (rules of use, warranty, license — not repeated here).

Last updated: 31 July 2026

---

## Who this covers

YourPHR is **self-hosted** personal health record software.

| Role | Role for privacy |
|---|---|
| **User** | Your records on the instance you use |
| **Instance operator** | Runs the server; responsible for that deployment’s security, access, backups, and any legal duties |
| **YourPHR project / yourphr.org** | Publishes software and this site; does **not** hold your health or Medicare data |

If someone else hosts your instance, ask **them** how they protect your data.

---

## What data is involved

**On an instance:** health records you import (including Medicare claims-related data such as Coverage and ExplanationOfBenefit when you connect Medicare); documents you upload; account login data for the instance; provider/OAuth tokens used to fetch data you authorized.

**Not by the project:** maintainers and yourphr.org do not receive your health records, Medicare claims, or tokens.

**This website:** static pages only; no health data; no first-party analytics cookies. The host may log standard request metadata (e.g. IP).

---

## How data is collected (including Medicare)

You may import files yourself or connect a patient-access API (SMART on FHIR), including **Medicare via CMS Blue Button**.

When you connect Medicare (or another provider):

1. You sign in with **that provider / CMS** — not with a YourPHR project account. We never ask for your Medicare.gov password.
2. You authorize **read** access to the scopes requested.
3. A short-lived OAuth **code** may pass through a public **sign-in relay** (~60 seconds in memory). The relay does **not** get tokens or health data. Your instance exchanges the code for tokens **directly with the provider/CMS**.
4. Tokens stay **encrypted on the instance**. Imported data is stored and shown only there (and on operator backups).

**Shared with CMS:** only what OAuth/API requires. **Shared with the YourPHR project:** nothing about your Medicare or clinical data.

**How long:** the instance may re-sync while the connection is authorized. **Disconnect / remove source** in the app removes that source’s stored OAuth credentials **and** the health records imported from it on this instance. **Delete account** removes your whole account and all of your data on this instance. Operator backups may still hold copies until the operator prunes them.

---

## How data is used

Only to display and organize health information for users of that instance.

The stock software is **not** designed to sell data, use it for advertising/marketing, or train commercial AI on your records. Default product does not send Medicare data to third parties for their own use. If an operator adds export/share features, they must disclose that.

**De-identified data:** stock software does not package your data for sale/research as de-identified datasets. Even “anonymized” health data can sometimes re-identify people.

---

## Third parties

| Who | Role |
|---|---|
| CMS / your providers | You authorize; they supply data under their rules |
| Sign-in relay | OAuth code only (~60s); no health data, no tokens |
| Operator’s host / reverse proxy / SSO | Access control and hosting — operator must secure them |
| GitHub Pages | Serves yourphr.org only |

---

## Your control

- Do not connect Medicare (or any source) if you do not want that import  
- **Disconnect / remove a source** (Sources → connected source → Actions): stops that connection and deletes records imported from that source on this instance  
- **Revoke Privacy & Terms** (Account Profile): blocks new Medicare connects and removes Medicare-class sources the same way as disconnect  
- **Delete account** (Account Profile): permanently deletes your account and all of your data on this instance  
- Ask the operator about backups or a full deployment wipe if needed  

**Dormant/closed accounts:** data remains on the operator’s storage until removed (including any backups). The project holds no enrollee databases.

---

## Security

Local storage, encryption at rest when enabled, no project copy of records, short-lived relay codes. Operators must also use HTTPS, access control, secure backups, and current software.

---

## Breach notification

The **instance operator** handles breaches of data on their deployment and notifies people as required by law (including, where applicable, the FTC Health Breach Notification Rule for personal health records).

The project does not hold your instance data. If project-run infrastructure (e.g. the public relay or this site) is involved in an incident, we will communicate through appropriate public channels.

---

## Sale or change of control

Open-source maintainer changes do **not** move your database. If a **hosted operator** is sold or changes data use, they must notify you when required; you should be able to disconnect sources and delete data.

---

## Changes to this policy

We may update this policy; the date above will change. For a CMS-approved Blue Button production app, policy/notice changes may need CMS review before rollout.

---

## Contact

- Project: [GitHub issues](https://github.com/jwilleke/yourphr/issues)  
- CMS Blue Button: [BlueButtonAPI@cms.hhs.gov](mailto:BlueButtonAPI@cms.hhs.gov)  
- Your instance: the operator who runs the server  
