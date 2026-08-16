# Architecture principles for the TypeScript stack

> **Status: adopted direction, 2026-08-16.** Operator decision: follow the concepts in [`jwilleke/ngdpbase`](https://github.com/jwilleke/ngdpbase) `src/` as far as they fit. This records *which* concepts, how they map onto a PHR, and — the part that matters — which ones do not transfer.

Companion to [`strategy-typescript-transition.md`](strategy-typescript-transition.md) (what is being built and when) and [`authorization-framework.md`](authorization-framework.md), which already derives from ngdpbase's `WikiContext` and `PolicyEvaluator`.

## Why adopt rather than invent

Two reasons, and only two — both worth stating so the adoption stays honest rather than reverent.

**It is the same author's solved problems.** ngdpbase is 101.5k lines of TypeScript with 38 managers and 36 providers, built by the person who will maintain this. Its patterns are already familiar, which for a single maintainer is an architecture constraint rather than a preference.

**One of its ideas has already paid off here.** The mail transport ([#536](https://github.com/jwilleke/yourphr/issues/536)) took ngdpbase's `console` provider default: with no relay configured, a message is logged rather than failing. That collapsed an entire planned phase — "what happens when SMTP is not set up" — into a default value. It was a better answer than the one this project had reasoned its way to.

## The invariant

**All code that touches a resource goes through that resource's manager. There is no second path.**

Everything else here follows from that one rule. The lifecycle, the backup contract, the providers, the policy evaluator — none of them is the idea. They are what becomes *possible* once a resource has exactly one door.

For a system holding medical records this is not a tidiness preference, because four things a PHR must do are only truthful if the chokepoint is real:

- **Access logging.** "Who read this record" is answerable only if every read passed one place. A single path that reaches around does not make the audit log *incomplete* — it makes it **wrong**, and wrong silently, which is the failure shape this project keeps finding ([#527](https://github.com/jwilleke/yourphr/issues/527), [#528](https://github.com/jwilleke/yourphr/issues/528)).
- **Authorization.** A policy evaluated at the door is enforced. A policy evaluated in 25 handlers is enforced 25 times and bypassed by the 26th.
- **Backup and restore.** A manager can answer "how are you backed up" only because it sees every write. This is why the base contract can demand it at all.
- **Encryption.** Same argument, same door.

### What follows: the base contract

`BaseManager` requires `initialize(config)`, `shutdown()`, **`backup()`** and **`restore()`** — and `BaseUserProvider` repeats `backup`/`restore` as abstract at the provider layer, so neither level can exist without answering it.

Compare where YourPHR is: backup is a feature that happens to exist, and it is **mutually exclusive with database encryption** ([#367](https://github.com/jwilleke/yourphr/issues/367), [#461](https://github.com/jwilleke/yourphr/issues/461), [#363](https://github.com/jwilleke/yourphr/issues/363)). Encrypted instances cannot back up at all. Nobody forgot; nothing forced the question.

### Where YourPHR already stands, and where it leaks

Go is closer to the invariant than expected: `DatabaseRepository` is a 69-method single path for records. Two known breaks:

- `pkg/web/demo_reset.go` calls `gorm.Open` and holds **its own connection** — a real second door to the same data.
- `pkg/web/handler/users.go` branches on `gorm.ErrDuplicatedKey` — not a second path, but the abstraction leaking its implementation's error vocabulary to a caller, which quietly welds the handler to GORM.

### The invariant has to be enforced, not documented

A rule that lives only in a document decays at the first deadline, and its decay is invisible — the code still works, the tests still pass, and only the audit log is quietly lying. So the boundary needs a lint rule: **only `managers/` may import the store or the driver**, with everything else importing managers. Then the check earns its place the way every other harness here has: delete the rule, prove CI goes red.

### What follows: capabilities are pluggable providers, with an inert default

ngdpbase pairs each capability with an interface and several implementations, chosen by config: auth (`Password`, `MagicLink`, `Authentik`, `CloudflareAccess`, `GoogleOIDC`, `AgentToken`), search (`Lunr`, `Elasticsearch`), cache (`Node`, `Redis`, `Null`), audit (`File`, `Database`, `Cloud`, `Null`), storage, media, attachments, backup.

Two properties matter more than the list:

- **A `Null` or `console` provider is the default.** The system is never broken for want of configuration; it degrades to inert. That is what made mail safe to ship half-finished, and it is why the public demo cannot email strangers by accident.
- **Registration is gated on a config key**, so an unconfigured capability is *absent* rather than half-present.

**Adopt:** the pattern and the inert default. **Do not** adopt the provider *count* — YourPHR does not need Elasticsearch or Redis, and a provider interface with one implementation is a layer, not an abstraction.

Providers are also what keeps the invariant from producing god objects. "One door" is not "one pile": ngdpbase's own `UserManager` is 1,600 lines carrying password hashing, permission resolution, Express middleware and wiki page creation, with three role methods already gutted to `never` after the split to `RoleManager`. That is what happens when a single path is read as a single class. The manager is the **gate**; the provider is the implementation behind it.

### What follows: policy is data, evaluated — not conditionals scattered through handlers

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

**Structure is not free**, and managers and providers are justified by different things — conflating the two tests is how this goes wrong in both directions at once.

- **A manager is justified by being the only door to a resource.** Not by having alternative implementations, and not by symmetry with ngdpbase's list. So the test is: *is this a resource, and would code otherwise reach it directly?* One manager per resource. If two managers own the same table, neither is a chokepoint and the invariant is already gone.
- **A provider is justified by a second implementation plausibly existing.** Auth, audit and storage: yes. Most else: no. A provider interface with one implementation and no candidate second is a layer, not an abstraction.

The failure mode to watch is not too many managers — it is **too few, each too large**, because "one path to users" was read as "one class for everything about users". `UserManager` at 1,600 lines is the worked example, in the codebase being copied from.

The other failure mode is quieter: the invariant erodes one convenient direct query at a time, and nothing goes red. That is why the lint rule matters more than this document does.
