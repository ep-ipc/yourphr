# Epic Data Use Questionnaire — answers of record

The answers filed for the **YourPHR** app (appId 56252) at [fhir.epic.com](https://fhir.epic.com/Developer/DataUseQuestionnaire?appId=56252), completed **2026-08-19**. Epic shows these answers to patients inside the OAuth approval screen, and requires them to be accurate and truthful — false answers can suspend the app. Both questionnaire versions (5/28/2021 and 12/27/2018) are answered; older Epic orgs only present the 2018 one.

**Answers freeze permanently when the app is marked Save & Ready for Production.** Until then they are editable. One answer is deliberately provisional — see the access-log row.

## Why these answers

YourPHR is self-hosted, open-source, and the project never receives any patient data. Every answer follows from that, verified against the code on the day of filing. Where no option matched exactly, the **under-claiming** option was chosen — never one that overstates a protection.

## Questionnaire from 5/28/2021

| Question | Answer | Why |
|---|---|---|
| Who offers the app | An individual or independent developer | Jim, open-source project — no company |
| How funded | Produced by volunteers / open source community | No ads, subscriptions, data sales, or VC |
| Where stored | Can store user data locally on the user's device | Self-hosted; runs on the user's own hardware |
| How long stored *(conditional)* | Indefinitely | Kept until the user deletes it; deletion is always available |
| Can users delete all data *(conditional)* | Yes, delete all | Remove data + delete account teardown ([#431](https://github.com/jwilleke/yourphr/issues/431)/[#437](https://github.com/jwilleke/yourphr/issues/437)) |
| Who else has access | People and groups users authorize | Multi-user family install; an operator runs the instance. "No one; never leaves the device" would overstate |
| Per-entity approval | Yes, users specifically approve for each entity | Accounts/access are granted individually, not by blanket privacy-policy consent |
| Notified of each access by default | No | No access notifications exist |
| Complete record of stored data | Yes | Full export/download exists |
| Data used beyond direct services | No | The project never receives data at all |
| Other individuals' data used | No one | — |
| **Record of who accessed data** | **No — only a partial record** | `LastLogin`/`LoginCount` ([#512](https://github.com/jwilleke/yourphr/issues/512)) show account use, but no per-record access log exists. **Upgrade to "Yes, complete record" when [#563](https://github.com/jwilleke/yourphr/issues/563) (P0, patient-visible access log) ships — BEFORE marking production-ready, or "partial" freezes forever** |
| Data retained after account deletion | No | Account deletion removes the records |

## Questionnaire from 12/27/2018

Same substance, that version's wording: individual/independent developer · **no BAA** (patient-facing app; no business associate agreements exist) · open source funding · stored locally on the user's device · people and groups users authorize · **"users authorize access generally and are not notified"** (no option matched "specific per-entity authorization, no notification" — this under-claims the authorization half rather than overstate the notification half) · complete record of collected data · users can delete all data · not retained after account closure · no use beyond direct services · stores data indefinitely · **partial** record of who accessed (same [#563](https://github.com/jwilleke/yourphr/issues/563) upgrade note).

## Filing mechanics (for the next edit)

- The page needs the "I understand customers will have access to my responses" acknowledgment clicked before the questions render; the acknowledgment re-arms on every reload.
- **Each question has its own Save Changes button** that appears once the answer changes — an unsaved answer is silently lost on navigation (the browser throws a "Leave site?" dialog as the only warning). Save per question, then reload and re-check the answers actually persisted; two answers were lost to missed saves on first filing.
- The 2018 questionnaire lives in a second tab panel; clicks on its inputs no-op while the 2021 tab is active — switch tabs first.
- Do **not** touch "Lock my answers" — locking is the same freeze as marking production-ready.

## Remaining before production distribution

1. [#563](https://github.com/jwilleke/yourphr/issues/563) lands → flip both access-log answers to "complete record".
2. Refresh-token proof on the confidential client (see [`epic-sandbox.md`](../epic-sandbox.md) — confidential since 2026-08-19).
3. Operator accepts the open.epic terms of use checkbox (legal agreement — the operator clicks it personally).
4. **Save & Ready for Production** — permanently locks the app and these answers; production client_id `dbef27b9-d302-4ed9-bea0-f933ef326be3` then distributes via Automatic Client ID Distribution (USCDI v3).
