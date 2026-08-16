# Strategy — freeze Go, build forward in TypeScript

> **Status: proposed, 2026-08-16.** The direction is the operator's decision. The sequencing, the rules and the stop conditions below are the part that needs agreeing before anything acts on it.

Companion to [`typescript-stack-evaluation.md`](typescript-stack-evaluation.md), which measured whether this is possible. This one is about whether it is *wise*, and how it would run.

## The decision

1. **Go development stops**, except security fixes.
2. **TypeScript is the forward path**, and carries no Fasten lineage — no `fasten-sources`, no `gofhir-models`, no inherited module path.

## What the spike established

Everything the evaluation called uncertain, except sync, now has a number against it — measured against a real 19,796-resource snapshot, not fixtures:

| Question | Answer |
|---|---|
| Generic indexing viable? | 551 lines against 18,518 generated Go lines |
| At real scale? | 20,061 resources, ~22s, 417k index rows |
| Identity seam? | **0 collisions** across 8 sources |
| Matches Medplum's reference? | 71/71 queries |
| Matches production? | **29/29 resource types, id for id** |
| Write path? | 11/11 — re-import, update, delete, reindex |
| Per-user isolation? | 6/6, including a resource id held by two accounts |
| Frontend contract? | 9/9, via an adapter |
| **Sync?** | **untested** |

## Three things to settle before this starts

### 1. "Security fixes only" is the wrong line for a PHR

Today's freeze-worthy examples argue against it. [#528](https://github.com/jwilleke/yourphr/issues/528) was a counter that silently never incremented — filed as a bug, but it meant **a password change did not end a stolen session**, which is security. [#525](https://github.com/jwilleke/yourphr/issues/525) was a dashboard showing 40 practitioners where the page listed 6 — not security at all, and yet a records system that misstates how much of your record exists is not merely untidy.

A record displayed wrongly is a patient-safety problem, not a cosmetic one. Proposed line instead:

**Fix: security, data correctness, and anything that misrepresents a record. Freeze: new capability.**

Under that rule today's work splits cleanly — [#529](https://github.com/jwilleke/yourphr/issues/529) and [#530](https://github.com/jwilleke/yourphr/issues/530) fixed, [#525](https://github.com/jwilleke/yourphr/issues/525) and [#528](https://github.com/jwilleke/yourphr/issues/528) fixed, [#524](https://github.com/jwilleke/yourphr/issues/524) Send to Email would **not** have been built.

### 2. The freeze has to survive contact with annoyance

The honest risk is not technical. It is that the freeze breaks the first time something in the daily-driver instance irritates its only user enough — and then it breaks again, and there was never a freeze, only a slower pace with more guilt.

Worth deciding in advance what happens when that occurs. The cheapest answer: **write the issue, label it `frozen`, do not fix it.** A visible list of things being consciously not-done is what makes a freeze real rather than aspirational, and it doubles as the TypeScript backlog.

### 3. "No Fasten items" costs more than it looks — and the cost is security

`fasten-sources-stub` is not a shim. It is 3,168 lines containing the **real SMART client**: `GetSourceClient`, `RefreshAccessToken`, capability discovery, binary/attachment fetch, patient-ID discovery — and **SSRF guarding** (`ssrf.go`, `GuardedTransport`, with its own test suite).

`fhirclient` covers launch, token exchange and refresh. It covers **nothing** of the SSRF hardening. A self-hosted PHR fetches URLs that a provider — or an attacker who can influence a provider response — supplies, from inside a home network. That guard exists because somebody thought about it.

So "no Fasten items in TypeScript" means **re-earning that hardening**, not just re-writing plumbing. It is doable and it is the single most dangerous line item in this plan, because it is the one where being wrong is a vulnerability rather than a bug.

Related, already filed: [#485](https://github.com/jwilleke/yourphr/issues/485) rejects obfuscated numeric hosts when a source is added.

## Sequencing

Each phase is its own issue, tracked under [#544](https://github.com/jwilleke/yourphr/issues/544) as native sub-issues and chained by `blocked by`. Nothing here is a step inside another issue.

| Phase | Issue | Blocked by |
|---|---|---|
| 0 — leave Fasten, stay on Go | [#538](https://github.com/jwilleke/yourphr/issues/538) | — |
| 1 — keep the read stack honest in CI | [#540](https://github.com/jwilleke/yourphr/issues/540) | — |
| **2 — sync, or stop** | **[#539](https://github.com/jwilleke/yourphr/issues/539)** | [#538](https://github.com/jwilleke/yourphr/issues/538) |
| 3 — authentication and sessions | [#541](https://github.com/jwilleke/yourphr/issues/541) | [#539](https://github.com/jwilleke/yourphr/issues/539) |
| 4 — the long tail | [#542](https://github.com/jwilleke/yourphr/issues/542) | [#539](https://github.com/jwilleke/yourphr/issues/539), [#541](https://github.com/jwilleke/yourphr/issues/541) |
| 5 — cut over, keep both, or stop | [#543](https://github.com/jwilleke/yourphr/issues/543) | [#542](https://github.com/jwilleke/yourphr/issues/542) |

Phases 0 and 1 are deliberately unblocked and worth doing even if Phase 2 fails.

**Phase 0 — leave Fasten, stay on Go.** Fold the stub in under YourPHR's own name, replace `gofhir-models`, decide the module path. Cheap, reversible, useful whether or not the rest happens, and it removes the liability of depending on a stub of a package that went private.

**Phase 1 — the read stack in TypeScript, shadowing.** Already built. Keep it honest by running the harness on the synthetic corpus in CI, and against a real snapshot after any storage change.

**Phase 2 — sync, or stop. Due 2026-09-30** ([#539](https://github.com/jwilleke/yourphr/issues/539), milestone *Phase 2 decision — TypeScript sync*). The decisive phase, attempted *before* anything is migrated for real, so that failing is cheap.

The gate is a **sandbox** provider, not production — [#408](https://github.com/jwilleke/yourphr/issues/408) has been open since July trying to prove a *production* provider end-to-end in Go, and holding TypeScript to a bar the working stack has not cleared would make this fail for the wrong reasons. Six sandboxes are already seeded.

**Mid-point signal, 2026-09-05:** the SSRF dispatcher should exist in some form. It is the piece with no library behind it; if it has not started by three weeks in, the end date is already lost, and week 3 is a better time to learn that than week 6.

Demonstrated means: one sandbox connected, a token refreshed, records stored with the differential harness still agreeing, **SSRF tests that fail when the guard is removed**, and a resync producing no duplicates.

**Phase 3 — auth and sessions.** Isolation is proven *given* a user id; establishing who the caller is is not built.

**Phase 4 — the long tail.** Provider catalog, DCR, background jobs, backup and restore, encryption, config, migrations, IPS renderers including PDF, the classifier, provenance, medication reconciliation. Roughly 22.7k hand-written Go lines, and the part with no library to adopt.

**Phase 5 — cut over, or keep both.** Only after 2–4.

## Stop rules, agreed in advance

A migration without a defined failure is one that cannot fail, only drag.

- **If Phase 2 is not demonstrated by 2026-09-30, stop.** Keep Go, keep the read stack as a shadow or delete it, and record why in this document. The date is a GitHub milestone rather than a line in a plan, so it is visible on the issue and on the board.
- **Only two things justify moving it**, and neither is being busy: [#408](https://github.com/jwilleke/yourphr/issues/408) landing in Go first, which would give a known-good reference for what production demands; or a provider registration stalling in somebody else's approval queue, as already happened with [#339](https://github.com/jwilleke/yourphr/issues/339).
- **If the freeze is broken twice for non-security work, the freeze is not real** — either widen the rule deliberately or abandon it, but do not keep pretending.
- **If two stacks are both serving production for more than one release cycle**, stop and pick one. A half-migrated system maintained by one person is worse than either endpoint.

## What this costs if it works

76.8k lines of Angular are kept — the frontend does not move. The adapter needed to keep it ([#537](https://github.com/jwilleke/yourphr/issues/537)) is bounded and known.

## What this costs if it fails

A Go instance frozen for however long the attempt lasted, carrying unfixed capability gaps, plus a TypeScript stack that never shipped. That is the real downside, and it is why Phase 2 comes before any migration rather than after.
