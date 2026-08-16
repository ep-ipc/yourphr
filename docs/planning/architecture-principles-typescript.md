# Architecture principles for the TypeScript stack

> **Status: adopted direction, 2026-08-16.** Operator decision: follow the concepts in [`jwilleke/ngdpbase`](https://github.com/jwilleke/ngdpbase) `src/` as far as they fit. This records *which* concepts, how they map onto a PHR, and — the part that matters — which ones do not transfer.

Companion to [`strategy-typescript-transition.md`](strategy-typescript-transition.md) (what is being built and when) and [`authorization-framework.md`](authorization-framework.md), which already derives from ngdpbase's `WikiContext` and `PolicyEvaluator`.

## Why adopt rather than invent

Two reasons, and only two — both worth stating so the adoption stays honest rather than reverent.

**It is the same author's solved problems.** ngdpbase is 101.5k lines of TypeScript with 38 managers and 36 providers, built by the person who will maintain this. Its patterns are already familiar, which for a single maintainer is an architecture constraint rather than a preference.

**One of its ideas has already paid off here.** The mail transport ([#536](https://github.com/jwilleke/yourphr/issues/536)) took ngdpbase's `console` provider default: with no relay configured, a message is logged rather than failing. That collapsed an entire planned phase — "what happens when SMTP is not set up" — into a default value. It was a better answer than the one this project had reasoned its way to.

## The three concepts worth taking

### 1. Every subsystem is a manager with a uniform lifecycle

`BaseManager` requires `initialize(config)`, `shutdown()`, **`backup()`** and **`restore()`**.

The interesting part is not the lifecycle — it is that **backup and restore are in the base contract**. A subsystem cannot exist without answering "how are you backed up?".

Compare where YourPHR is: backup is a feature that happens to exist, and it is **mutually exclusive with database encryption** ([#367](https://github.com/jwilleke/yourphr/issues/367), [#461](https://github.com/jwilleke/yourphr/issues/461), [#363](https://github.com/jwilleke/yourphr/issues/363)). Encrypted instances currently cannot back up at all. That is exactly the gap a base contract prevents: it is not that somebody forgot, it is that nothing forced the question.

**Adopt:** the contract, including backup/restore.

### 2. Capabilities are pluggable providers, with an inert default

ngdpbase pairs each capability with an interface and several implementations, chosen by config: auth (`Password`, `MagicLink`, `Authentik`, `CloudflareAccess`, `GoogleOIDC`, `AgentToken`), search (`Lunr`, `Elasticsearch`), cache (`Node`, `Redis`, `Null`), audit (`File`, `Database`, `Cloud`, `Null`), storage, media, attachments, backup.

Two properties matter more than the list:

- **A `Null` or `console` provider is the default.** The system is never broken for want of configuration; it degrades to inert. That is what made mail safe to ship half-finished, and it is why the public demo cannot email strangers by accident.
- **Registration is gated on a config key**, so an unconfigured capability is *absent* rather than half-present.

**Adopt:** the pattern and the inert default. **Do not** adopt the provider *count* — YourPHR does not need Elasticsearch or Redis, and a provider interface with one implementation is a layer, not an abstraction.

### 3. Policy is data, evaluated — not conditionals scattered through handlers

`PolicyManager` + `PolicyEvaluator` + `PolicyValidator`: allow/deny policies as objects, validated on load, evaluated against a context.

YourPHR today has **25 in-handler admin checks across 7 files, reached through two duplicate helpers** ([`authorization-framework.md`](authorization-framework.md)). A third role would mean revisiting 25 sites, each an independent chance to be wrong.

**Adopt:** policy-as-data with an evaluator. The validator matters as much as the evaluator — a policy store that accepts a typo is a policy store that silently widens access to medical records.

## What does not transfer

Recording this so the adoption does not become cargo-culting.

| ngdpbase concept | Why not |
|---|---|
| **Page-oriented ACL** | Its ACL secures *pages*. A PHR secures *resources and compartments*, which is what Medplum's declarative Access Policies are built for. The `PolicyEvaluator` **shape** transfers; its subject model does not. |
| `PageManager`, `CommentManager`, `FootnoteManager`, `TemplateManager`, `RenderingManager`, `VariableManager` | Wiki domain. No PHR analogue. |
| `src/plugins/` | JSPWiki-style **markup macros**, not application modules. "YourPHR as an ngdpbase plugin" is not an available shape — this was checked. |
| 38 managers | A count, not a design. A PHR needs perhaps a third of that, and inventing managers to match the number would be structure for its own sake. |

## What this means concretely

- **Sync** ([#539](https://github.com/jwilleke/yourphr/issues/539)) becomes a manager with providers per source type, an inert default, and — because the base contract demands it — an answer for how connected-source state is backed up.
- **Auth** ([#541](https://github.com/jwilleke/yourphr/issues/541)) uses the provider pattern directly. `PasswordAuthProvider` is the one YourPHR needs today; `MagicLink` and OIDC exist upstream if wanted later, and the point of the interface is that they can arrive without rework.
- **Audit** — ngdpbase already has `DatabaseAuditProvider` / `FileAuditProvider` / `NullAuditProvider`. That is directly the unresolved thread on [#507](https://github.com/jwilleke/yourphr/issues/507), and the thing [#524](https://github.com/jwilleke/yourphr/issues/524) needs for recording what was emailed to whom.
- **Backup** stops being a feature and becomes part of every manager's contract, which is the only way the encryption/backup exclusion stops being permanent.

## The honest risk

**Structure is not free.** 38 managers and 36 providers is a lot of ceremony, and a PHR maintained by one person can drown in indirection as easily as in duplication. The failure mode is a provider interface with exactly one implementation, wrapped in a manager with a lifecycle nothing uses.

The test to apply, each time: **would a second implementation ever plausibly exist, and does the base contract force a question worth being forced?** For auth, audit and storage the answer is yes. For most other things it will be no.
