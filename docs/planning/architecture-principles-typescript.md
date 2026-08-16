# Architecture principles for the TypeScript stack

> **Status: adopted direction, 2026-08-16.** Operator decision: follow the concepts in [`jwilleke/ngdpbase`](https://github.com/jwilleke/ngdpbase) `src/` as far as they fit. This records *which* concepts, how they map onto a PHR, and — the part that matters — which ones do not transfer.

Companion to [`strategy-typescript-transition.md`](strategy-typescript-transition.md) (what is being built and when) and [`authorization-framework.md`](authorization-framework.md), which already derives from ngdpbase's `WikiContext` and `PolicyEvaluator`.

## Why adopt rather than invent

Two reasons, and only two — both worth stating so the adoption stays honest rather than reverent.

**It is the same author's solved problems.** ngdpbase is 101.5k lines of TypeScript with 38 managers and 36 providers, built by the person who will maintain this. Its patterns are already familiar, which for a single maintainer is an architecture constraint rather than a preference.

**One of its ideas has already paid off here.** The mail transport ([#536](https://github.com/jwilleke/yourphr/issues/536)) took ngdpbase's `console` provider default: with no relay configured, a message is logged rather than failing. That collapsed an entire planned phase — "what happens when SMTP is not set up" — into a default value. It was a better answer than the one this project had reasoned its way to.

## The model

The whole architecture, stated without reference to records, wikis, or any particular resource. Everything after this section is application.

1. **A resource has exactly one manager, and no other path reaches it.**
2. **Context is request-scoped and says who is asking.** It is passed into managers; managers are not reached through it.
3. **Managers decide and act. Providers implement and return.** A provider reports a result; only the manager turns that result into an effect.
4. **Configuration binds capabilities to providers; providers supply behaviour.** Config selects and parameterises. It never expresses logic.
5. **A capability that is not configured is never loaded.**
6. **Every action on a resource is a named permission**, declared as data in one registry: `{target}-{action}`.
7. **Roles collect permissions.** Nothing more — a flat list, additive only.
8. **Capability and scope are separate.** A role says *what* may be done; the assignment says *over which subjects*. Neither is ever encoded in the other's name.
9. **Evaluation is tiered, and the resource's own attributes beat global policy.** That is how "everything except" is expressed without deny entries.
10. **Decisions come in two forms**: one item, or a filter over many. Both are part of the contract, because a list endpoint that improvises its own check is a hole.
11. **Access without an account is a principal, not a bypass.** A share token resolves to a subject and goes through the same evaluator.
12. **Every one of these is an invariant, so every one needs a check that fails.** A rule enforced only by documentation decays silently, while the tests stay green.

Points 6 through 11 are enforceable only because of point 1: without exactly one door, none of them can be relied on.

## The goal is a reusable framework

The intent is a core that is **architecturally complete and customised through providers and configuration rather than forked code**. That is a different target from "an application built well", and it changes one of the tests below, so it belongs here rather than as an afterthought.

**Why the timing is right rather than premature.** Framework extraction fails when it is done up front, or from two similar applications. ngdpbase is application one and already exists; YourPHR is application two, in an unrelated domain. A wiki and a medical-records system sharing a core is a hard test — seams that survive that gap will survive most things.

**Where the framework must stop.** It cannot know what a compartment is, or what FHIR is, yet the evaluator needs scope. So `resource → scope` resolution is an **application-supplied extension point**. If page-ness is hardcoded anywhere in the evaluator, YourPHR forks on day one and the framework is fiction. That single seam is the test of whether any of this is real.

| Framework owns | Application supplies |
|---|---|
| Engine and lifecycle, config system, manager and provider base contracts, auth, policy evaluator, audit, users/roles/sessions, backup and restore contract, share tokens, the permission registry *mechanism* | Its resources and their managers, the permission registry *contents*, its scope resolver, its providers, its UI |

**The extension path must be the path the built-ins use.** From ngdpbase's own `AuthManager`: *"Addons register through the same method, so the contributed path is the one exercised on every boot rather than a second, less-travelled one."* If built-ins take a privileged shortcut, the path adopters depend on is the path nobody tests.

**Give it a falsifiable test**, in the spirit of [#539](https://github.com/jwilleke/yourphr/issues/539)'s stop rule, because "architecturally complete" is otherwise a feeling: **can YourPHR be built with zero edits to framework files?** Count the patches. Each one is a seam in the wrong place — useful data, but only if somebody is counting.

**The cost, stated rather than discovered:** two consumers means a breaking change hurts twice, so the base contracts need a stability guarantee and real versioning. And YourPHR's migration becomes coupled to framework churn on top of the Go freeze and a dated stop rule — three concurrent projects, when the freeze is already the fragile part. Mitigation: **copy the pattern into YourPHR first, extract the package second.** The seams are learned from two implementations in hand; predicting them is where frameworks die.

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

### Capability, not provider type

A capability is one job — audit storage, PHI storage, cache, search index. A provider type is a reusable implementation of that job. The **binding** is what configuration chooses, and the same type can be bound several times with different settings:

```text
phi.storage        → filesystem
audit.storage      → s3
backup.storage     → s3          (different bucket, different credentials)
attachment.storage → filesystem
```

"One active" applies to a binding, never to a class. And this composition is not merely permitted — it is often the better architecture. Keeping PHI on the family box while shipping audit off-box is **tamper-evidence**: an attacker who owns the machine can rewrite a local audit log and erase what they did. An audit trail the local administrator cannot alter is the entire point of having one.

Which argues for **finer capabilities in the framework**. A single `StorageProvider` means PHI and logs can never be separated and the operator has no lever at all; four named capabilities means they can compose.

**Every storage binding is independently a data-egress decision.** `phi.storage.provider = "s3"` relocates medical records to Amazon, and in a config file it looks identical to choosing a cache backend. The same care applies to the audit example above: an entry reading *"user X read Alice's Condition/123"* is disclosive on its own, so off-box audit means off-box **and** encrypted client-side, or off-box to storage the operator controls.

So the config system needs a third marker alongside the existing `secret` list: **keys whose value moves PHI off the machine.** Loud in the admin UI, defaulted local, and never altered by an upgrade that finds the default untouched. A PHR whose premise is that records stay in your house must not lose that to a one-word edit that reads like a backend choice.

### Cardinality is a property of the capability

Four kinds, and two of them look identical until they are wrong:

| Cardinality | Examples | On failure |
|---|---|---|
| **One active** | PHI storage, cache, search index | Capability is down |
| **Any-of** (alternatives) | password *or* OIDC *or* magic link | A failed login — never a silent fallback to the next provider, which turns a lockout into an oracle |
| **All-of** (factors) | password *and* TOTP | Denied |
| **Broadcast** | audit sinks, notifications | See below |

For a capability that is *one active*, switching providers is a data migration — and `backup()`/`restore()` from the base contract is exactly that path. The contract adopted for disaster recovery turns out to be the filesystem-to-S3 move as well.

**The hazard is between any-of and all-of, and it is live in ngdpbase today.** `ngdpbase.auth.required-factors` is an ordered list meaning *all of these*, six providers are registered simultaneously as alternatives, and the manager's own header says *"Currently single-factor only; multi-factor state management is deferred."* Whoever implements MFA must satisfy every entry in order: wiring it as "try each until one succeeds" turns multi-factor into a bypass, because the attacker simply presents the factor they hold. Same list, same providers, opposite security property — worth a test written before the feature.

**Broadcast failure is a policy decision, not a default.** If an audit sink is unavailable, does the operation proceed? For records the answer is that a disclosure which was not audited did not happen: refuse the export or the share rather than complete it unlogged. Wrong for a wiki's page views, right for PHI leaving the system.

### Not configured means not loaded

Skipping instantiation saves almost nothing — an unused manager object is a few kilobytes. Skipping the **module** saves a great deal, because the cost is the dependency it drags in: an image toolchain, a headless browser for PDF rendering, a Redis or Elasticsearch client. Tens to hundreds of megabytes resident, plus native initialisation at boot.

So the gate must be a **dynamic `import()` inside the factory**. A top-level `import` of the implementation defeats config gating entirely — the module loads and its native bindings initialise regardless, and the config key only decides whether it is called. That distinction is the whole feature and is invisible in review unless looked for. This matters because the deployment target is a family box, not a datacenter.

**The stronger argument is not memory, it is attack surface.** Code that never loads cannot be exploited. An instance with no connected sources should not have the SMART client and its URL-fetching path live at all — and that is the component carrying the SSRF guard already flagged as the most dangerous item in the migration. "Not installed" beats "guarded".

Two traps:

- **Absent must not mean null.** If `getManager('image')` returns null, every call site needs a check and the one that forgets crashes on real data. Keep the capability addressable and make the *implementation* inert; the saving already happened by not importing the real module. No caller branches — the same disease as 25 scattered admin checks.
- **Absent must be visible.** An install where a feature silently does nothing because a config key is missing is indistinguishable from a bug. Log the resolved provider set at boot. That is the mail lesson: inert is fine, inert *and invisible* is a support ticket.

### Providers keep the invariant from producing god objects

Providers are also what keeps the invariant from producing god objects. "One door" is not "one pile": ngdpbase's own `UserManager` is 1,600 lines carrying password hashing, permission resolution, Express middleware and wiki page creation, with three role methods already gutted to `never` after the split to `RoleManager`. That is what happens when a single path is read as a single class. The manager is the **gate**; the provider is the implementation behind it.

### What follows: policy is data, evaluated — not conditionals scattered through handlers

`PolicyManager` + `PolicyEvaluator` + `PolicyValidator`: allow/deny policies as objects, validated on load, evaluated against a context.

YourPHR today has **25 in-handler admin checks across 7 files, reached through two duplicate helpers** ([`authorization-framework.md`](authorization-framework.md)). A third role would mean revisiting 25 sites, each an independent chance to be wrong.

**Adopt:** policy-as-data with an evaluator. The validator matters as much as the evaluator — a policy store that accepts a typo is a policy store that silently widens access to medical records.

## The layering: context, manager, provider

Three layers, one job each.

- **Context** is request-scoped. It carries the engine, the current user, and the request/response — *who is asking, in what request*. It is passed **into** manager calls.
- **Manager** is the door to a resource. It decides, enforces policy, audits, and turns a provider's result into an effect.
- **Provider** does the actual work and **returns a result**. It does not act on it.

That last ordering is what makes auditing trustworthy. Because the provider only reports, the manager is the single place where a success becomes a session, an audit entry, a counter bump. Two providers cannot each write half a story.

### Context is request-scoped, not session-scoped

A session outlives a request, so authorization facts held for the length of a session go stale inside it: a role is revoked, an account disabled, a password changed, and a long-lived context still says admin. Build the context fresh per request from session state, and keep session state behind the user provider.

Two kinds of thing live in it, with opposite safety needs:

- **Authorization facts** — subject, roles, compartments, token generation. Built once at the edge and then **immutable**. If a handler can write to it, a handler can widen its own permissions.
- **Request incidentals** — locale, timezone, theme, user agent, client IP. Mutable, harmless.

ngdpbase's `WikiContext` places them side by side and marks all of them optional: `authenticated?: boolean` sits next to `dateFormat` and `activeTheme`. Since `undefined` is falsy, a missing value fails closed *by luck* rather than by design. For a wiki that is fine. For medical records, failing closed by accident is one refactor away from failing open — so the authorization fields should be required, not optional.

**Holding the engine on the context is fine.** The risk was never `ctx.engine`; it is `ctx.engine.getManager('records').db` — reaching *past* a manager to the store. That is what the lint rule above forbids. Engine-on-context plus an enforced store boundary is coherent, and threading the engine separately would be more ceremony for the same guarantee.

### Authentication returns a result, not a boolean

`authenticated: true | false` discards what the manager needs next. ngdpbase's own `AuthResult` is already richer than a boolean, and the comment explaining why it grew is the useful part: the manager always passed `viaToken` along, but the type did not admit the field existed, so a provider that misspelled it still compiled and silently delivered nothing.

For records the result should carry the subject, which provider authenticated, which factors were satisfied, issued-at and expiry, and the **token generation**. That last one is [#528](https://github.com/jwilleke/yourphr/issues/528) exactly: *"this session should end because the password changed"* is unanswerable if authentication returned `true`.

## Authorization

### Permissions are `{target}-{action}`

The registry format ports unchanged — target first, hyphen separated, URL-safe. ngdpbase defines 19 across five targets (`admin`, `asset`, `page`, `search`, `user`).

Two of its choices are already right for records and were arrived at independently here:

- **`page-export` is separate from `page-read`.** Reading one record on screen and extracting the whole chart to a file are different acts with different risk — access versus disclosure. The split is not a PHR special case; it is already in the registry.
- **`search` is a target, not an action.** Search leaks *existence*: being told "3 results you may not open" already discloses that the records exist.

A first cut for YourPHR:

```text
record   read export share annotate edit delete
source   read connect sync delete
user     create read edit delete
admin    read roles system
search   record
```

`record-share` is split from `record-export` because share crosses the trust boundary and export lands on the operator's own disk. `record-edit` is kept rather than omitted, and constrained at the resource level instead — see the provenance lock below.

### Roles are a flat list of permissions

A role is a list of permission strings and nothing more — `editor = [page-read, page-edit, page-create, …]`. Flat (no roles inside roles), unordered (no entry beats another), and **additive only** (every entry grants; none takes away).

Two of ngdpbase's role decisions are worth taking directly:

- **`issystem`** separates built-in roles from operator-created ones, so an admin cannot quietly redefine what a role means. That is worth more for records than for pages.
- **`anonymous` is a role**, not an `if` somewhere. The unauthenticated path goes through the same evaluator with a near-empty permission list — the single-path invariant applied to the case where the special-case branch usually hides.

Its `demo-admin` role — sees every admin screen, changes nothing, cannot see the user list — is exactly what YourPHR's public demo needs and currently handles ad hoc.

**Where a flat list runs out:** it says *what* may be done, never *whose records*. That is the compartment, below. And because it is additive only, it cannot express "everything except" — which the tiered evaluator answers instead of deny entries.

### Compartments are whose records, not which actions

**A compartment is every resource about one person** — Alice's Conditions, Observations, MedicationRequests, Encounters and Claims, across all resource types. The word is FHIR's, not ours, and the spec defines per resource type which field links a record back to its subject (`Observation.subject`, `Condition.patient`, and so on), so "is this record in Alice's compartment" has a defined answer rather than a guessed one.

**YourPHR already has one; it just is not named.** The `user_id` column does this job today, and the spike proved that isolation holds 6/6. The concept only starts earning its keep when user and patient stop being one-to-one — family sharing, where one person reaches several compartments: their own, a minor child's, an aging parent's.

It is the right unit because the alternatives fail plainly: per-resource grants explode and need a new row for every record that arrives tomorrow, and granting by resource type is the wrong axis — nobody grants "Observations", they grant a person's chart. A compartment covers what has not arrived yet, and turns into a query predicate rather than thousands of individual decisions.

(Shared reference data — Practitioner, Organization, Medication — belongs to no compartment, so its readability is a separate question.)

**Scope never goes in a name.** Not `record-read-patient-123` as a permission, and not `guardian-of-alice` as a role. Both explode combinatorially and neither can be listed in a config registry. The role stays compartment-free and the **assignment** carries the scope: `(grantee, role, compartment, granted_by, expires_at, revoked_at)`. At family scale that is a small table, not a distributed authorization system.

### The evaluator is tiered, and resource-level attributes win

ngdpbase evaluates in tiers — **author-lock, then the resource's own audience/access, then global policies** — with resource-level attributes overriding the global ones.

This is the answer to "everything except", and a better one than adding deny entries to role lists. Sensitivity is a property of *the record*, not of the grant, so it belongs on the record. Two resource-level controls port directly:

**`audience` becomes confidentiality.** This is where adolescent confidentiality and 42 CFR Part 2 substance-use protections actually live, and FHIR already has the slot — `meta.security` confidentiality codes, plus `Observation.category`. A record marked restricted overrides a guardian's compartment grant, without every grant having to enumerate what it must not reach.

**`author-lock` becomes a provenance lock.** Patients legitimately edit records they authored themselves — a home blood-pressure reading, a note. They must never edit a record imported from a provider, because the record still carries that provider's provenance. One mechanism covers both cases, which is why `record-edit` survives as a permission.

**One deliberate divergence:** ngdpbase's author-lock denies everyone except admin. For records there should be **no override at all**. An admin fixing a wiki page is maintenance; an admin editing an imported lab result is falsifying a clinical record that still claims a provider as its source.

### Deciding one record and filtering many are both first-class

A wiki decides one page per request. A record list asks about thousands. If the evaluator only offers `decide(ctx, action, resource)`, list endpoints will grow their own path — and that path will not be audited.

So both forms are part of the contract:

- `decide(ctx, action, resource)` for a single record
- `filter(ctx, action, query)` — policy compiled into a **query predicate** for lists

This is not a hypothetical risk. ngdpbase's own `ACLManager` carries the scar in a comment: `getRecentChanges` consulted `audience` only on already-private pages, so **a non-private page with an audience was listed to viewers**. A listing path partially reimplemented the check and leaked. That is the strongest available argument for `filter()` being a first-class form rather than something each list endpoint improvises.

### Sharing without an account

ngdpbase's share routes — `/share/:token`, plus `/file/:id`, `/thumb/:id`, `/page/:name`, with create and revoke management — are the shape [#524](https://github.com/jwilleke/yourphr/issues/524) needs: giving a new specialist read access to part of a chart without them holding an account. SMART Health Links standardise exactly this for health data and should be followed rather than reinvented.

**A separate route tree is structurally where the second door appears.** Those handlers must resolve the token into a *principal* and then go through the same evaluator. If they answer access questions themselves, everything above is decoration.

What records demand beyond what a wiki needs:

- **A token in a URL leaks by design** — history, referer headers, proxy logs, and chat platforms that fetch pasted links to build previews. SHL's answers apply: short expiry, a passcode delivered separately, a short-lived manifest rather than the content itself.
- **Every use is audited**, on every route and not only the landing one. A share fetch is a disclosure — arguably the most audit-worthy event in the system.
- **Revocation is immediate**, and a share is bounded by compartment *and* confidentiality rather than being all-or-nothing.

### Keeping the registry honest

The registry and the enforcement points are two lists that must agree, and nothing checks that they do. In ngdpbase's config each permission carries an `icon` and a `color`, which reveals the registry's day job is rendering the admin screen while enforcement lives at scattered call sites.

So the harness, in the spirit of everything else here: **assert that every permission in config is checked somewhere in code, and that every check names a permission that exists in config.** It catches drift in both directions — an orphan permission that protects nothing, and a check spelled `record-view` when the registry says `record-read`. One fails open and looks fine; the other fails closed and also looks fine.

The related split: **the action vocabulary belongs to code** (a permission string no code path checks is inert — it looks like protection and is not), while **role-to-permission bindings belong to config**, where they are genuinely deployment policy.

### None of this binds today

YourPHR is one user, one account, with per-user isolation. Compartments, guardianship, confidentiality tiers and sharing all arrive with **family sharing**, which is not built. The ask now is narrower: do not let the evaluator's shape foreclose them. An evaluator that can only add permissions together is a decision, even when it is made by not deciding.

## What does not transfer

Recording this so the adoption does not become cargo-culting.

| ngdpbase concept | Why not |
|---|---|
| **Page-oriented ACL** | Its ACL secures *pages*. A PHR secures *resources and compartments*, which is what Medplum's declarative Access Policies are built for. The `PolicyEvaluator` **shape** transfers; its subject model does not. |
| `PageManager`, `CommentManager`, `FootnoteManager`, `TemplateManager`, `RenderingManager`, `VariableManager` | Wiki domain. No PHR analogue. |
| `src/plugins/` | JSPWiki-style **markup macros**, not application modules. "YourPHR as an ngdpbase plugin" is not an available shape — this was checked. |
| The manager *list* | A count is not a design. YourPHR's managers follow from its own resources, not from matching ngdpbase's roster. (This is about the list, not the granularity — on providers and capabilities the position is now to err **fine**, for the reasons above.) |

## What this means concretely

- **Sync** ([#539](https://github.com/jwilleke/yourphr/issues/539)) becomes a manager with providers per source type, an inert default, and — because the base contract demands it — an answer for how connected-source state is backed up.
- **Auth** ([#541](https://github.com/jwilleke/yourphr/issues/541)) uses the provider pattern directly. `PasswordAuthProvider` is the one YourPHR needs today; `MagicLink` and OIDC exist upstream if wanted later, and the point of the interface is that they can arrive without rework.
- **Audit** — ngdpbase already has `DatabaseAuditProvider` / `FileAuditProvider` / `NullAuditProvider`. That is directly the unresolved thread on [#507](https://github.com/jwilleke/yourphr/issues/507), and the thing [#524](https://github.com/jwilleke/yourphr/issues/524) needs for recording what was emailed to whom.
- **Backup** stops being a feature and becomes part of every manager's contract, which is the only way the encryption/backup exclusion stops being permanent.

## The honest risk

**Structure is not free**, and managers and providers are justified by different things — conflating the two tests is how this goes wrong in both directions at once.

- **A manager is justified by being the only door to a resource.** Not by having alternative implementations, and not by symmetry with ngdpbase's list. So the test is: *is this a resource, and would code otherwise reach it directly?* One manager per resource. If two managers own the same table, neither is a chokepoint and the invariant is already gone.
- **A provider is justified by someone plausibly needing to replace it.** For an application that means a second implementation you would write yourself, which is a narrow test. For a **framework** the second implementation is the *adopter's*, and the question becomes whether a customiser would otherwise have to fork. That is a much wider licence, and it is the licence the framework goal asks for.

An earlier draft of this document applied the narrow test and concluded "do not adopt the provider count". Three arguments overturned it: the framework goal makes replaceability the adopter's concern rather than ours; finer capabilities are what let an operator separate PHI storage from audit storage at all; and a capability that is never loaded costs nothing, so granularity is close to free. Erring granular is now the position.

What has *not* changed is that a provider interface must have a plausible second implementation by **someone**. A layer nobody will ever swap is still a layer.

The failure mode to watch is not too many managers — it is **too few, each too large**, because "one path to users" was read as "one class for everything about users". `UserManager` at 1,600 lines is the worked example, in the codebase being copied from.

The other failure mode is quieter: the invariant erodes one convenient direct query at a time, and nothing goes red. That is why the lint rule matters more than this document does.
