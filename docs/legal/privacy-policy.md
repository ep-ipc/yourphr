# Privacy Policy — YourPHR

**Public URL (published):** [https://yourphr.org/privacy.html](https://yourphr.org/privacy.html)  
**Source for maintainers:** this file (`docs/legal/privacy-policy.md`). When you change it, update `gh-pages` `privacy.html` and the “Last updated” date.  
**CMS note:** Material changes to this policy that apply to a Blue Button production app may need CMS pre-approval before rollout — see [Blue Button production access](https://bluebutton.cms.gov/production-access/).

Last updated: 31 July 2026

---

## Who this policy is for

**YourPHR** is free, open-source software for a **self-hosted personal health record (PHR)**. How privacy works depends on **who is running the server**:

| Role | What they do | What this policy says |
|---|---|---|
| **You as the user** | Import and view **your own** (or your family’s) records on an instance you control | Your data stays on that instance; the open-source project does not receive it |
| **Instance operator** | Runs the server (you, a family admin, or an organization) | The operator is responsible for that deployment’s security, access control, backups, and any legal duties (e.g. HIPAA if they are a covered entity) |
| **YourPHR project / yourphr.org** | Publishes software and this website | Does **not** operate a multi-tenant “YourPHR cloud” that holds enrollees’ Medicare data |

If you use a **hosted instance** run by someone else (for example a demo at `yourphr.nerdsbythehour.com`), that **operator’s** practices apply in addition to this software description. Ask the operator for their contact and policies.

---

## What data is involved

### On a self-hosted (or operator-hosted) instance

The software can store and process:

- **Health information** you import: FHIR resources (for example clinical records, and for Medicare **claims-related** data such as ExplanationOfBenefit and Coverage), documents you upload (for example C-CDA/XML or PDFs)
- **Account data** for logging into the instance (username, password hash — not your Medicare.gov password)
- **Provider connection data**: SMART/OAuth client settings you configure, and **access/refresh tokens** used to fetch *your* data from a provider or from **Medicare (CMS Blue Button API)** when you connect that source

By default the application database is designed to be **encrypted at rest** when encryption is enabled and active. You (or the operator) control encryption keys, backups, and who can log in.

### Data the YourPHR project does **not** collect

The maintainers and **yourphr.org** do **not** receive your health records, Medicare claims, provider tokens, or instance account passwords. There is no project back-end that stores enrollees’ Blue Button data.

### This website (yourphr.org)

Static site (e.g. GitHub Pages). No health data. No first-party analytics cookies. The host may process standard web logs (for example IP address); see the host’s privacy documentation.

---

## How Medicare (CMS Blue Button) data is collected

When you choose to connect **Medicare** via the CMS Blue Button API:

1. You sign in with **Medicare / CMS**, not with YourPHR project accounts. YourPHR never asks for or stores your Medicare.gov password.
2. You authorize **read access** to the scopes the app requests (typically limited claims-related resources such as Patient, Coverage, and ExplanationOfBenefit — not write access to CMS).
3. CMS returns a short-lived authorization **code**. A public **sign-in relay** may hold that code in memory for about **60 seconds** so your instance can retrieve it. The relay does **not** receive access tokens, refresh tokens, or health data. Your instance exchanges the code for tokens **directly with CMS**.
4. Tokens are stored **encrypted on the instance** and used only to download the authorized data into that instance.
5. Imported data is shown to you in the app and stored only on that instance (and any **backups the operator** makes).

**What is shared with CMS:** only what is required for OAuth and API access (client registration details the operator configured, and the OAuth exchange you complete). **What is shared with the YourPHR project:** nothing about your Medicare data.

**Persistent collection:** After connect, the instance may re-fetch data when you sync, until you disconnect the source or tokens expire. Duration depends on whether a refresh token is available and on operator settings. Disconnecting removes stored credentials for that source from the instance.

---

## How data is used

On the instance, data is used **only** to help **you** (and other users the operator allows on that instance) view and organize health information.

YourPHR software is **not** designed to:

- Sell your data
- Use it for advertising or third-party marketing
- Train commercial AI models on your records
- Share it with third parties for their own purposes

**Sharing:** The default product does not send your Medicare data to third parties for their use. If an operator enables features that export or share data, that is under the operator’s control and must be disclosed by the operator. You should not be surprised by how your data is used; if something is unclear, do not connect Medicare until it is clear.

**De-identified / anonymized / pseudonymized data:** The stock software does not package your Medicare data for sale or research as de-identified datasets. If an operator does that, they must say so. Even “anonymized” health data can sometimes re-identify people; we do not claim zero re-identification risk for any dataset derived from real records.

---

## Third parties

Depending on how you run YourPHR, limited technical parties may process **non-health** or **transient** data:

| Party | Role | Health data? |
|---|---|---|
| **CMS / Medicare (Blue Button API)** | You authorize; they provide claims-related data | Yes — at CMS, under CMS rules |
| **Sign-in relay** (optional public callback helper) | Holds authorization **code** ~60s only | No health data; no tokens |
| **Operator’s host / reverse proxy / SSO** (e.g. Authentik) | Login to the instance | Should not hold Medicare claim payloads if configured only as access control |
| **GitHub Pages** (yourphr.org only) | Serves this policy site | No |
| **Your cloud/VPS provider** (if any) | Runs the machine/disk | Operator must protect disks and backups as PHI/PII |

Operators should ensure vendors that handle personal information meet legal and contractual expectations for the sensitivity of the data.

---

## Your choices and control

You can typically:

- **Choose not to connect** Medicare or any provider
- **Disconnect** a source (removes stored OAuth credentials for that source on the instance)
- **Delete** records or your account (where the product provides delete account / delete resource features)
- **Stop using** the instance or ask the operator to wipe the deployment and backups

**If you revoke access at Medicare/CMS** (or tokens expire), the instance may no longer fetch new data. **Data already imported** remains on the instance until you or the operator delete it — unless your operator’s policy says otherwise. This policy’s default for the software is: **previously imported data stays until deleted on the instance**; disconnect does not automatically purge all historical imports unless you delete them or wipe the database.

**Dormant or closed accounts:** If you stop using the instance, data remains on disk until the operator deletes the account, database, or backups. Operators should define retention for unused accounts. The project holds no dormant enrollee databases.

---

## Security

The software is intended to reduce risk of unauthorized access: local storage, optional/at-rest DB encryption, no project-side copy of records, short-lived relay codes. Operators must also use HTTPS, strong access control, secure backups, and current software versions.

No system is perfect. You and the operator share responsibility for securing the machine and accounts.

---

## Breach notification

If a **security or data breach** affects health information on an instance:

- The **instance operator** is responsible for assessing the incident and notifying affected people as required by law (for example the FTC [Health Breach Notification Rule](https://www.ftc.gov/legal-library/browse/rules/health-breach-notification-rule) for certain personal health records, and other federal/state rules that may apply).
- The **YourPHR project** does not hold your Medicare data, so it cannot notify you of a breach of *your* instance. If the project’s own systems (e.g. the public relay or website) are breached in a way that could affect users, we will describe the issue through public channels (e.g. GitHub security advisories / site notice) as appropriate.

Notifications should explain what happened and practical steps you can take when that information is available.

---

## If the project or operator is sold or control changes

- **Open-source project:** A change in maintainers does not move your instance’s data; your data remains on your (or your operator’s) server.
- **Operator / hosted instance:** If the organization running your instance is sold or changes how data is used, **that operator** must notify you if the law or their commitments require it, and you should be able to export or delete data and disconnect Medicare. Do not assume a sale of the open-source trademark equals a sale of your database.

---

## Changes to this policy

We may update this policy. The “Last updated” date will change at this URL.

For a **Blue Button production** application approved by CMS, **draft changes and enrollee notification language may need CMS review before you roll them out** (see CMS production-access guidance). Operators of production Blue Button apps must follow that process.

---

## Contact

- Project / policy questions: [GitHub issues](https://github.com/jwilleke/yourphr/issues)  
- CMS Blue Button program: [BlueButtonAPI@cms.hhs.gov](mailto:BlueButtonAPI@cms.hhs.gov)  
- **Your instance operator:** whoever runs the server you use (for hosted demos, contact that operator)

---

## CMS privacy-policy checklist map (maintainer aid)

| CMS production-access expectation | Where addressed above |
|---|---|
| How app collects and shares data | Medicare section; use; third parties |
| What is shared and with whom | CMS, relay, operator host; project shares nothing |
| One-time vs persistent collection | Persistent until disconnect/token end; re-sync |
| De-identified data | Explicit section |
| Revoke / retain vs delete | Control and deletion |
| Dormant / closed accounts | Control section |
| Policy update notification | Changes section + CMS pre-approval note |
| Third-party vendor protections | Third parties |
| Breach notification | Breach section |
| Sale / change of control | Sale section |
| Enrollee-readable | Plain language throughout |
| Public URL | yourphr.org/privacy.html |
