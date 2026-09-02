# Moving YourPHR onto ngdpbase — what it would take, and what it would buy

> __Status: analysis, 2026-08-30. Not adopted, nothing decided.__ Session notes from stepping through
> the question *"can YourPHR clone ngdpbase and work within it?"* Written down because the question
> keeps recurring and has been answered from structure rather than from evidence each time — see
> [yourphr#697](https://github.com/jwilleke/yourphr/issues/697), which argues it from repo layout alone.
>
> __Amended 2026-09-02__ with the security-posture comparison, and two claims it superseded — see that
> section and the strikethrough under *What flows the other way*.
>
> Read with [`architecture-principles-typescript.md`](https://github.com/jwilleke/ngdpbase/blob/master/docs/planning/architecture-principles-typescript.md),
> which now lives in ngdpbase. That document is the governing one and already answers part of this.

## The question, stated properly

Not *"should YourPHR use ngdpbase's ideas"* — `AGENTS.md` already mandates that, below `KIT:END`:

> __DEFAULT TO ngdpbase__ — the code, not its docs. When this stack needs a mechanism ngdpbase already
> has, take ngdpbase's shape as it is built. __Improvements are FILED, not built in flight.__
> A divergence is legitimate only if that document names it.

The open question is the stronger one: __does YourPHR become an ngdpbase deployment__ — cloning the
platform and shipping the PHR as an add-on — rather than a separate application that copies its shapes?

## How ngdpbase is actually consumed

Checked against the two live consumers rather than assumed.

- __ngdpbase is not on npm.__ `npm view ngdpbase` returns 404. It is a *clone-and-extend* platform.
- __Consumers take a base image.__ `geohazardwatch` builds `FROM ghcr.io/jwilleke/ngdpbase:${NGDPBASE_VERSION}`
  and installs its domain as a published add-on package (`@jwilleke/geohazardwatch-addon`). Neither
  `geohazardwatch` nor `fairways-gen2-website` has ngdpbase as a dependency — the base image *is* the
  dependency.
- __An add-on is a full application module__: its own managers, Express routes, background jobs, views,
  plugins, config and data. Not a markup macro.

One shape is explicitly ruled out by the governing document, and it is the one people assume:

> `src/plugins/` — JSPWiki-style __markup macros__, not application modules.
> __"YourPHR as an ngdpbase plugin" is not an available shape — this was checked.__

## Scale

| | Lines |
|---|---|
| ngdpbase `src/` | 110,522 |
| — its managers alone | 25,958 |
| YourPHR `src/` (whole backend) | 13,797 |
| — `src/framework/` | 3,649 |

ngdpbase has 40 managers; YourPHR has 14. Adoption means carrying the platform to reach roughly
4k lines' worth of horizontal services — unless the vertical features below are worth the freight.

## What it would buy: the open-issue overlap

The strongest argument, and the one missing from [yourphr#697](https://github.com/jwilleke/yourphr/issues/697).
These are __open YourPHR issues that ngdpbase core already implements__:

| Open issue | ngdpbase core capability |
|---|---|
| [#632](https://github.com/jwilleke/yourphr/issues/632) In-app help pages — markdown shipped with the code (__P1__) | *"Required pages — committed to repo, auto-installed on first run"* + Markdown pages with frontmatter |
| [#633](https://github.com/jwilleke/yourphr/issues/633) Help content — the pages a patient needs (__P1__) | Content authoring, no code |
| [#436](https://github.com/jwilleke/yourphr/issues/436) Bootstrap and themes (__P1__) | Theme System — `themes/core.css`, per-theme variable overrides, admin switcher |
| [#499](https://github.com/jwilleke/yourphr/issues/499) instance default light/dark | Light / dark / system-preference via CSS variables |
| [#500](https://github.com/jwilleke/yourphr/issues/500) `ui.theme-name` wired to nothing | ThemeManager lists themes automatically |
| [#502](https://github.com/jwilleke/yourphr/issues/502) Azia BS4 → Bootstrap 5.3 colour modes | The same theme system, already built |
| [#536](https://github.com/jwilleke/yourphr/issues/536) Outbound mail transport (__P1__) | `EmailManager` |
| [#687](https://github.com/jwilleke/yourphr/issues/687) "Email this summary" 404s | `EmailManager` |
| [#631](https://github.com/jwilleke/yourphr/issues/631) Backups must restore the instance (__P1__) | Backup and restore, instance-level |
| [#709](https://github.com/jwilleke/yourphr/issues/709) per-user settings have no store | `UserManager` + `NotificationManager` per-user state |
| [#695](https://github.com/jwilleke/yourphr/issues/695) agent tokens — no UI | `AgentTokenManager` + the `profile.ejs` card, mint form, live table, revoke, admin oversight |
| Token-expiry notification, deferred in [#695](https://github.com/jwilleke/yourphr/issues/695) | `NotificationManager` — per-user, with expiry and dismiss |
| [#714](https://github.com/jwilleke/yourphr/issues/714) Maintenance mode — no way to say the instance is briefly not itself | The gate, the page, the toggle, the notification and the config, all shipped |

Thirteen issues, four of them P1.

### The gap nobody had filed: maintenance mode

Worth separating from the rest of the table, because it was found the opposite way round. Every other
row is an issue somebody wrote down and ngdpbase happens to answer. This one had __no issue at all__
until [#714](https://github.com/jwilleke/yourphr/issues/714), and it was invisible for the reason
missing capabilities usually are: nothing fails, so nothing gets filed. The product simply has no way
to say *"this instance is briefly not itself"*, and every operation that needs to say it has quietly
worked around the absence.

It surfaced from [#713](https://github.com/jwilleke/yourphr/issues/713). A rebuild of the search index
over 20,000 resources measures __48.5 seconds__, and `reindexAll()` empties both derived tables before
repopulating them — so search returns nothing throughout. Without a maintenance mode the options are
all bad: rebuild under live traffic and let a household member watch search break and heal, or stop
the process, which on Kubernetes means scaling to zero and back. The ordinary answer — put up a page,
do the work, take it down — was not available.

ngdpbase has all of it: `src/app.ts:705-738` (the gate, after the session resolves so it knows whether
the caller is an admin), `WikiRoutes.ts:9496` (the toggle, `admin-system` gated and logged),
`views/maintenance.ejs`, `NotificationManager.ts:322` (every user told), and four config keys. The
details that carry the design are the unglamorous ones — the exemption list for `/admin`, `/login` and
static assets, without which the admin cannot reach the switch that turns it off; `allow-admins`
defaulting true; and a real `503` rather than a `200`.

__One defect to fix on adoption rather than after.__ `adminToggleMaintenance()` mutates
`engine.config` in memory and nothing persists it, so a pod restart during maintenance — a rollout, an
OOM kill, a node drain — brings the instance back live with nobody told. For an index rebuild that is
worse than having no maintenance mode: the index would be neither old-and-complete nor
new-and-complete, and the instance would be serving from it. This stack has a persisting configuration
overlay, so writing through it is a small change. Worth filing upstream as well, since every ngdpbase
consumer has the same hole.

The general lesson is the one this document keeps running into from the other direction. The
core-versus-add-on section below is mostly about what YourPHR would __contribute__; this is the
clearest case of what it would __receive__, and it took a performance measurement on an unrelated bug
to notice a capability that was never missed because nothing ever demanded it out loud.

__Document search is a real want, not a wiki artefact.__ [#599](https://github.com/jwilleke/yourphr/issues/599)
shipped full-text search over *record text*. Help content is a different corpus needing a different
index, and ngdpbase's Lunr `SearchProvider` is exactly that.

## The front end is where it breaks — and how far

The obvious shape is: ngdpbase serves its EJS chrome, the Angular bundle is served as add-on static
assets. __Two front ends. That was rejected on sight, and rightly.__ Two navigations, two session
surfaces, two search boxes, a patient who clicks *Help* and lands somewhere that looks like a
different product.

But the theming half of that objection turns out to be wrong, and it matters:

- ngdpbase themes are __Bootstrap 5 native__. `themes/default/css/variables.css` sets `--bs-body-bg`,
  `--bs-link-color`, `--bs-border-color` and layers semantic vars over them; the file says so:
  *"Bootstrap 5 native variables — set here so Bootstrap components and our semantic vars below both
  stay consistent."* `themes/core.css` uses 25 `--bs-*` properties.
- ngdpbase loads Bootstrap __5.3__ (5.3.0 and 5.3.3 by CDN; not a package.json dependency).
- YourPHR's Angular app is on `bootstrap@5.3.8` with `@ng-bootstrap@21`.

Same framework, same minor, same custom-property contract. __One `variables.css` can theme both
surfaces__ with no token-unification project — and [#502](https://github.com/jwilleke/yourphr/issues/502)
is precisely the migration that would let the Angular side consume it.

So the front-end objection is narrower than "two front ends": it is __navigation, session and search__,
not styling.

## What it would actually take

In order of size.

1. __The HTTP layer.__ `src/server.ts` is 1,295 hand-rolled `node:http` lines carrying the session
   cookie, the Bearer path, the agent-token gate, the demo gate and the access-log gate as inline
   middleware. ngdpbase is Express. That gets dismantled into add-on routes plus Express middleware.
   This is the bulk of the work.
2. __PHI stays in the add-on and cannot become pages.__ ngdpbase pages are plain Markdown on disk, and
   core states plainly: *"Encryption at rest for private pages (planned future enhancement)"* — not
   available. Records keep their SQLCipher store behind YourPHR's own managers. That is normal for an
   add-on, but *"private pages must never hold PHI"* becomes a stated rule, not an assumption.
3. __One front end has to be chosen.__ Either the Angular app consumes help content over an API and
   renders it in its own chrome, or help lives in EJS and the patient crosses a boundary. Unresolved,
   and the deciding question is below.
4. __Dependency surface.__ 110k lines and ngdpbase's dependency tree join the supply chain of a PHI
   store. A posture decision to make deliberately.

__The SSRF boundary is not the blocker it appears to be.__ YourPHR's hard rule is that all outbound
network access goes through `src/http`, enforced by `scripts/check-http-boundary.sh`. ngdpbase core has
__three__ genuine server-side outbound call sites: `ImportManager.ts:958`, `WikiRoutes.ts:1591`,
`WikiRoutes.ts:13094`. The other matches are client-side `fetch()` emitted into browser JS
(`CommentsPlugin`, `FootnotesPlugin`) and a plugin lifecycle method that happens to be named `fetch`.
Routing three call sites through a guarded fetch is a day, not a programme.

## Encrypted SQLite: the seam exists, the implementation does not

The provider architecture would accept an encrypted SQLite store — that much is right, and it is the
reason this is worth doing at all. But the base is emptier than it looks, and the direction of travel
is the opposite of what it seems:

- __ngdpbase has no SQLite anywhere.__ 85 dependencies, and none of `sqlite`, `sqlcipher`,
  `better-sqlite3`, `knex` or `pg`. Every shipped provider is file-based: `FileSystemProvider`,
  `VersioningFileProvider`, `FileUserProvider`, `FileAuditProvider`, `FileBackupProvider`.
- __`DatabaseAuditProvider` is a scaffold__, not an implementation: 196 lines carrying six `TODO`s,
  including *"TODO: Implement database client initialization"*. The governing document already says
  an operator who configures it *"gets an instance that believes it has an audit trail and has none"*.
- __YourPHR holds the working implementation.__ SQLCipher, `ATTACH DATABASE … KEY …` +
  `sqlcipher_export()` for encrypted consistent backups under a separately-held key, and a database
  provider that owns the connection.

So encrypted SQLite is not something YourPHR __receives__ from ngdpbase. It is the largest single
thing YourPHR __contributes__, and it lands in a seam ngdpbase has kept open and never filled. Worth
naming plainly, because "the base handles it" is the assumption that would set the schedule wrong.

## Has `src/server.ts` outlived its usefulness?

### What it actually is

68 route matches across seven labelled sections, and every section is a __product feature__, not
infrastructure: the account page ([#596](https://github.com/jwilleke/yourphr/issues/596)), agent tokens
([#695](https://github.com/jwilleke/yourphr/issues/695)), Users
([#604](https://github.com/jwilleke/yourphr/issues/604)), the provider catalog
([#603](https://github.com/jwilleke/yourphr/issues/603)), Sources
([#594](https://github.com/jwilleke/yourphr/issues/594)), the dashboard and record pages
([#595](https://github.com/jwilleke/yourphr/issues/595)), practitioners
([#683](https://github.com/jwilleke/yourphr/issues/683)).

That reframes the rewrite. It is not 1,295 lines of bespoke HTTP machinery to be deleted — it is the
product's API surface, which survives the move and is re-expressed as Express handlers. The five gates
become middleware. __Mechanical, not conceptual__, and the mechanical part is where the effort is.

### Multi-tenancy is the wrong word, and the distinction matters

The hand-rolled server can fairly be called past its usefulness: it was built to prove a spike could
serve the Angular contract with no framework, and that is proven. Express plus ngdpbase's middleware
would carry the same 68 routes with less bespoke code.

But __per-user isolation is not multi-tenancy overhead, and a family instance needs it most.__ A
household has several people in it. A spouse's records and a teenager's records are exactly what must
not be visible to each other by default. The governing document draws the line: *"Compartments are
whose records, not which actions."* YourPHR measured 6/6 on per-user isolation. (`repoForUser` was the pre-[#608](https://github.com/jwilleke/yourphr/issues/608)
mechanism and is gone from `src/` — it survives only in two test harnesses. The live shape is
narrowing *inside the manager*: see the slice below.)

So: __the requirement survives the move; the implementation is negotiable.__ Per-request repository
resolution may be heavier than a family instance needs, and that is a fair thing to test.

What the move does __not__ hand over is the compartment model itself. The governing document is
explicit that ngdpbase's ACL secures *pages*, and *"the `PolicyEvaluator` shape transfers; its subject
model does not."* Users, sessions and roles come from the host; deciding whose records these are stays
YourPHR's, inside the add-on.

## One vertical slice, mapped: the Sources page

Taken end to end so the "mostly mechanical" claim above is tested rather than asserted.
Source: `src/server.ts:812-890`, `src/app/managers/SourcesManager.ts`.

### What the slice contains

Ten routes. Eight are one line each, of the identical shape:

```ts
send(res, 200, {success: true, data: await src.listShaped(ctx)});
```

A single regex carries six of them —
`^/api/secure/source/([^/]+)(?:/(summary|sync|disconnect|remove-data|export))?$` — dispatching to
`getShaped`, `remove`, `summary`, `syncNow`, `disconnect`, `removeData`, `exportBundle`. Every one
takes `ctx` and an id and returns data. The route layer holds __no domain logic at all__: it decodes,
calls one manager method, and shapes a 404 or a 500.

Two routes are not plain JSON:

- __Server-sent events__ — `/api/secure/events/stream`, Go's framing, a 15-second keep-alive, and
  `unsubscribe()` on client close.
- __A file download__ — `export`, which sets `application/fhir+json` and a `Content-Disposition`
  attachment filename and writes the body itself.

### How it maps

| YourPHR today | Under ngdpbase | Cost |
|---|---|---|
| Manual `url.pathname ===` matching | `app.get('/api/secure/source', …)` | Mechanical |
| One regex, six actions, method checks by hand | `/:id`, `/:id/summary`, `/:id/sync`, … as Express params | Mechanical, and a simplification |
| `send(res, 200, {success, data})` | `res.json({success, data})` | Mechanical |
| SSE by hand | Precedent in host: two `text/event-stream` endpoints in `WikiRoutes.ts`, both using `res.flushHeaders()` | Direct |
| `Content-Disposition` download | Precedent in host: the audit-log export | Direct |
| `SourcesManager` and its provider | Unchanged — add-on manager, `ctx` passed in | __Zero__ |
| The five request gates | Express middleware, but each needs a host equivalent or a port | Real work, done once for all slices |

__The managers do not move.__ `SourcesManager` already takes `ctx` on every call and narrows inside
itself. That is the whole point of [#608](https://github.com/jwilleke/yourphr/issues/608), and it is
what makes the host swappable.

### Isolation is already in the right place

Worth correcting an earlier assumption in this document. Compartmentalisation is __not__ a
per-request repository handed down from the server any more. `repoForUser` is gone from `src/` — it
survives only in `scripts/provenance-tests.ts` and `scripts/worker-tests.ts`. The live mechanism is
inside the manager:

```ts
// RecordsManager
private who(ctx: ApiContext): string { ctx.requireAuthenticated(); return ctx.username; }
const userId = this.who(ctx);
await this.provider.search(userId, …);

// SourcesManager
return (await this.provider.list()).filter((s) => s.userId === ctx.username);
if (source.userId !== ctx.username) throw new ApiError(403, '…');
```

This is exactly the governing document's clause (b) — *narrow inside the door, never at the route* —
so __isolation survives a host swap untouched__. The server carries none of it.

### The one genuine hazard

ngdpbase has __both__ context shapes in the tree:

- `src/context/ApiContext.ts` with `static from(req, engine)` — per request, the good one.
- `WikiEngine.setContext(context)` / `get context()` — __a process-global slot__, still present at
  `src/WikiEngine.ts:103-120`.

The governing document already names the second as one of the five mechanisms to tighten, in these
terms: *"Request state on a singleton; the session-scoped trap this document names, one concurrent
request from a cross-user leak."* YourPHR diverged deliberately and has no global context.

Hosting the PHR inside ngdpbase puts a PHI add-on in the same process as a global context slot the
host's own wiki routes use. That is not a blocker — the add-on takes `ctx` explicitly everywhere and
need never read `engine.context` — but it must become __a stated rule with a lint behind it__, in the
same family as `check-store-boundary.sh` and `check-http-boundary.sh`: *nothing under the add-on reads
`engine.context`.* Delete the rule, prove CI goes red.

### What the slice says about the whole

For this slice the estimate holds: the manager and its provider move unchanged, the routes are a
mechanical re-expression, and both non-JSON responses have working precedent in the host. The
irreducible work is the __gate layer__ — session and Bearer, the agent-token gate, the demo gate, the
access-log gate — which is written once and then serves all seven sections, plus the context lint
above.

The slice is representative of six of the seven sections. It is __not__ representative of
`/api/secure/events/stream`'s subscription model under a multi-worker Express deployment, which is a
question this slice raises and does not answer.

## What flows the other way

YourPHR has mechanisms ngdpbase lacks. These are filed against ngdpbase, per the working agreement.

- ~~__`scripts/check-http-boundary.sh` and the SSRF guard (47 checks).__ ngdpbase has no outbound
  boundary at all, and its three call sites are unguarded.~~ __Superseded 2026-09-02.__ ngdpbase now
  ships `src/http/{egressPolicy,guardedFetch,guardedLookup,ssrf}.ts` and its own
  `scripts/check-http-boundary.ts`, with no raw `fetch(` left outside tests. It went __further__ than
  this stack: [ngdpbase#1133](https://github.com/jwilleke/ngdpbase/issues/1133) added
  operator-configurable `ngdpbase.security.egress.allowed-ranges` / `denied-ranges`, reconciled by
  longest-prefix match with deny winning a tie (D8 of the security-posture record) — a layer YourPHR
  does not have, since `src/http/ssrf.ts` hardcodes the inward ranges. The issue itself is still open,
  so this is the boundary being built rather than the work being closed.
- __`scripts/check-store-boundary.sh`.__ The governing document's own known-gaps table still records
  this lint as *"Not written. Until it exists, the invariant is documentation"* — YourPHR wrote it.
- __Audit refuses to boot.__ YourPHR never had the `NullAuditProvider` fallback ngdpbase had to fix in
  its #1118; `AuditManager` states the divergence deliberately.
- __Agent-token scopes as auditable access categories.__ A surface that cannot be logged cannot be
  scoped — structurally stronger than ngdpbase's *owner minus admin* rule. __Sharpened 2026-09-02__,
  and the enforceable half is the other one: YourPHR runs the ceiling __once, at the HTTP edge__, so an
  unnamed surface is refused by inheritance. ngdpbase enforces at two call sites reached by convention,
  which is how [ngdpbase#1164](https://github.com/jwilleke/ngdpbase/issues/1164) happened — twelve
  places bypass it by passing a username string instead of a context. The transferable property is
  __default-deny at one choke point__, not the read-only category map, which is YourPHR-specific.
- __Demo mode's guards are a method gate, not an absent permission.__ ngdpbase's `demo-admin` is
  read-only because the role holds only `admin-read`; YourPHR refuses by HTTP method at the edge
  (`DemoManager.refuseUnlessRead`) and again at named manager doors. Same asymmetry as the agent-token
  ceiling above — permission-absence fails open on a route that forgot to require a write permission.
  YourPHR additionally __verifies__ the demo password against the stored hash and regenerates on drift,
  which has no upstream analogue. Per-IP rate limiting on the sign-in routes is core and already flowed
  down, so it is not a gap.
- __It cannot boot with auditing off.__ `AuditManager.ts:228` still loads `NullAuditProvider` when
  `ngdpbase.audit.enabled` is false — a deliberate opt-out upstream rather than the fallback its #1118
  removed. YourPHR ships no Null provider, so the choice does not exist here.
- __Encryption at rest.__ SQLCipher on both databases (`SqliteDatabaseProvider.ts:18`,
  `SqliteFhirRepository.ts:108`) plus `backup.encryption.key`. ngdpbase has no `encryption.key` and no
  SQLCipher — downstream of it having no relational store, so this is the *"large, into declared holes"*
  row of the core-improvements table rather than a defect.
- __Audit writes are durable per event, and undefended.__ `SqliteDatabaseProvider.ts:16` opens the app
  database — which holds `access_events` — setting neither `journal_mode` nor `synchronous`, so SQLite's
  defaults apply and every `record()` commits and fsyncs before it returns. ngdpbase's `FileAuditProvider`
  queues in memory and flushes on a 30-second timer, with only the critical tier fsynced since its #1158.
  So YourPHR is __ahead on the axis its own audit is weakest elsewhere__ — but by accident, not decision:
  nothing states durability was the reason, and `SqliteFhirRepository.ts:111` already sets
  `journal_mode = WAL` on the *records* database. Copying that one line to the app database for
  performance drops the log to WAL + `synchronous=NORMAL`, where commits are not fsynced, and no test
  would notice. __Pin `synchronous = FULL` explicitly, with the reason in a comment.__

Two defects worth filing upstream, found while reading:

- __ngdpbase ships two contradictory audit rules.__ Its #1111 and the governing document say audit
  writes are fire-and-forget with a caught error — *"refusing a credential mint because the log failed
  is worse."* Its #1121 registry marks `token.mint` __critical tier__, meaning the record must land
  before the action. Both are in the tree.
- __Bootstrap is pinned twice__, at 5.3.0 and 5.3.3 in different views, by CDN rather than as a
  dependency.

## Core improvement or add-on? Sorting what YourPHR would contribute

If the move happens, the same question arrives for every piece: does it improve ngdpbase for
everyone, or does it belong to the PHR? Getting this wrong in either direction is expensive — put
domain logic in core and every consumer carries it; put a mechanism in the add-on and the next
derivative rebuilds it.

### The line is already drawn

The governing document's split table settles the principle: core owns *"engine and lifecycle, config
system, manager and provider base contracts, auth, policy evaluator, audit, users/roles/sessions,
backup and restore contract, share tokens, the permission registry __mechanism__"*; the derivative
owns *"its resources and their managers, the permission registry __contents__, its scope resolver, its
providers, its UI."*

__Mechanism to core. Contents to the add-on.__

### The project has already tested it, in both directions

- __Wrongly core, moved out.__ `addons/demo` exists because demo pages went into core
  `required-pages/` first, which shipped them everywhere: *"The Fairways and the temp build both carry
  'Demo Welcome' on disk today, offered as __New__ in their required-pages sync screens. Demo content
  belongs to the demo."*
- __Rightly core, flowed down.__ `SimpleRateLimiter` is a core utility, and YourPHR ported it for
  [#647](https://github.com/jwilleke/yourphr/issues/647).

So the working test is concrete: __would The Fairways or GeoHazardWatch want this?__ If yes, it is core.

### Core improvements

| Contribution | Why core | Size |
|---|---|---|
| SQLite / SQLCipher providers | ngdpbase has no SQLite, but the seams are cut — `DatabaseAuditProvider` is a scaffold and `database.type` is advertised in config | Large, into declared holes |
| Outbound HTTP boundary and the SSRF guard | Three unguarded `fetch()` sites; the most reachable is gated on the __page edit ACL__, so any author can make the server fetch any URL and keep the bytes. Filed as [ngdpbase#1133](https://github.com/jwilleke/ngdpbase/issues/1133) | Medium |
| Retire `WikiEngine.setContext()` | The doc names it as one concurrent request from a cross-user leak | __Small__ — see below. Filed as [ngdpbase#1132](https://github.com/jwilleke/ngdpbase/issues/1132) |
| The store-boundary lint | The doc calls it core and unwritten; YourPHR wrote it. Filed as [ngdpbase#1134](https://github.com/jwilleke/ngdpbase/issues/1134) | Small |
| Typed manager registry; dependency-ordered boot; provider factory with required-vs-optional | Three of the doc's own five "mechanisms to tighten" | Large |
| ~~Agent-token lifecycle audit~~ | __Not an upstream gap.__ ngdpbase shipped it in its #1111, and its #1121 made critical events flush before the action with a coherent failure policy — `recordAuditEvent` refuses when a sink cannot promise durability and rethrows for critical events. The gap is __ours__: `AgentTokensManager` emits no audit at all | — |
| A per-subject audit view | `searchAuditLogs(filters, options, caller)` is operator-facing only. *"Show a person what was read about them"* is GDPR Article 15 — any application holding personal data | Medium |
| Cross-manager backup quiescing | The doc names it as engine-level work | Large |
| Encryption and egress as binding attributes | The doc names it as a known gap | Medium |

### Add-on

The FHIR store and repository; the Records, Sources, Catalog and Glossary managers; classification,
IPS composition, medication reconciliation and provenance; SMART, DCR and the relay wiring; the Go
migration tooling; the Angular application. Plus two the governing document assigns explicitly: __the
compartment model__ (*"the `PolicyEvaluator` shape transfers; its subject model does not"*) and __the
nine access-log categories__, which are registry contents rather than mechanism.

### Three worth arguing

- __Demo mode.__ ngdpbase answered this for *content*. YourPHR's demo is different in kind: a shared
  account whose password is __verified, not trusted__, writes refused at the manager door, and the
  password regenerated when the configured value and the stored hash drift apart. That is mechanism.
  Split it — core takes *"a shared credential whose writes are refused at the door"*, the add-on keeps
  which writes and the content.
- __Rate limiting.__ Already core and already flowed down. But `SimpleRateLimiter`'s own header says
  *"not suitable for distributed deployments (each pod has its own counter)"*, and YourPHR runs on
  Kubernetes. The upstream improvement is a shared-store limiter, not a new mechanism.
- __Agent-token scopes as auditable categories.__ YourPHR's own insight — *a surface that cannot be
  logged cannot be scoped*. The __derivation__ is core; the category map is add-on.

### Proportion, by line

| Destination | Lines | Share |
|---|---|---|
| Core improvements — `framework` 3,649, `http` 513, `log`, `config`, `events` | ~4,650 | 34% |
| Add-on domain — `app` 3,315, `migrate` 820, and the FHIR/classification/IPS/SMART cluster | ~7,050 | 51% |
| Glue that dissolves — `server.ts` 1,295, `app.ts` 454, `cli` 330 | ~2,080 | 15% |

One caveat on the first row: most of `framework/` is __not missing__ from ngdpbase. It is a parallel
implementation with five deliberate tightenings. What is genuinely absent from core is shorter and
higher-value — the SQLCipher provider, the HTTP boundary, and the hardening list.

Which inverts the usual framing. __YourPHR's contribution upstream is mostly security invariants, not
features__: the two boundary lints, the guarded fetch, audit that refuses to boot, and no global
context. They are what a PHR forced into existence and a wiki never would have, and every ngdpbase
consumer inherits the benefit.

### Filed upstream so far

| Issue | What | Grade |
|---|---|---|
| [ngdpbase#1132](https://github.com/jwilleke/ngdpbase/issues/1132) | `WikiEngine.setContext()` — a process-global request-state slot with zero callers | P2, latent |
| [ngdpbase#1133](https://github.com/jwilleke/ngdpbase/issues/1133) | SSRF — NCM image localization fetches any URL a page author writes, gated only by the page edit ACL | P1, __live__ |
| [ngdpbase#1134](https://github.com/jwilleke/ngdpbase/issues/1134) | The store-boundary lint the architecture document records as missing, and the drift it would already catch | P2 |
| [ngdpbase#1164](https://github.com/jwilleke/ngdpbase/issues/1164) | The agent-token scope ceiling is bypassed by __call shape__ — `UserManager.hasPermission()` skips it when handed a username string, and twelve call sites do exactly that, five of them the `admin-system` gate on admin writes. A `page-read` token reaches organization delete, required-page edit and the deleted-page browser, while `AgentTokenManager` refuses `admin-*` at mint | P0, __live__ |

A fourth was drafted and __withdrawn before filing__. The claim was that ngdpbase ships contradictory
audit durability rules — fire-and-forget in its #1111 against `token.mint` marked critical in
its #1121. Reading `recordAuditEvent` shows no contradiction: it looks the event type up in the registry,
__refuses__ when a critical event meets a sink that cannot promise durability, awaits
`flushAuditQueue()` when it can, and rethrows on failure for critical events only. The fire-and-forget
rule governs non-critical events. The policy is coherent, and #1121 is what made it so.

The real gap that resembles it is __ours__: `AgentTokensManager` in this repo emits no audit event on
mint, renew or revoke — the defect ngdpbase fixed in its #1111 and we have not adopted. It is one of
the six held audit gaps.

### `WikiEngine.setContext()` is dead surface, not a refactor

Sized by grep rather than by assumption, and the answer is better than the doc implies. `WikiEngine`
declares `public context: WikiContext | null` with `setContext()` and `getContext()` around it — and
__nothing calls them.__ Searched `src/`, `tests/`, `views/` and every bundled add-on:

- The only `setContext(` matches in `src/` are the definition itself, a doc-comment *example* on the
  line above it, and `WikiDocument.setContext()` — a different method on a different class.
- The only `getContext()` matches are its own definition and doc example, plus
  `WikiContext.getContext()`, which returns a *string* naming the context type (`EDIT`, `VIEW`) and is
  unrelated.
- `engine.context` is never read as a field anywhere.

Managers already take context as a parameter — `options.context`, `wikiContext` — which is the shape
the governing document asks for. The migration happened; the slot was simply never removed.

So the risk is __latent, not active__: today nothing leaks, but a public mutable `context` on a
process-wide singleton is a loaded gun for the next person who finds it and thinks it is the intended
way to pass a caller. In a wiki that surfaces someone else's draft. In a PHI store it is a
cross-patient disclosure.

Retiring it is deleting one field, two methods and a constructor parameter — a small, high-value
upstream contribution that should land __before__ a PHI add-on shares that process, not after.

__Filed upstream as [ngdpbase#1132](https://github.com/jwilleke/ngdpbase/issues/1132)__ (2026-08-31),
as the first of the contributions in this section. It stands on its own merits and needs none of the
platform decision.

## Where the governing document already stands

Relevant because a divergence is only legitimate if that document names it:

- __The verdict:__ *"copy the pattern into YourPHR first, extract the package second."* YourPHR is
  named as the second application that would prove the framework seams.
- __Extraction has barely begun.__ Exactly one file in ngdpbase carries an extraction note —
  `AgentTokenManager.ts`, which parameterises `CONFIG_PREFIX` and `TOKEN_PREFIX` for *"when this class
  moves into the shared framework package."*
- __What does not transfer__ is scoped to the __records domain__: page-oriented ACL cannot secure FHIR
  compartments, and `PageManager` / `RenderingManager` / `TemplateManager` have no PHR analogue *for
  records*. That table has been over-applied to the whole product — help pages and themes are exactly
  where those managers do have an analogue.

## Security posture — ngdpbase settled it in the open, and YourPHR has most of the gaps

> __Added 2026-09-02__, after reading [`docs/security-posture.md`](https://github.com/jwilleke/ngdpbase/blob/master/docs/security-posture.md) in ngdpbase against this tree. Twenty-three numbered decisions, D1–D23, each naming the issue that carries it; [ngdpbase#1137](https://github.com/jwilleke/ngdpbase/issues/1137) closed 2026-09-02 with all twelve sub-issues landed. This is __not a plan__ — `ngdpbase.security.posture` and `ngdpbase.audit.chain-witness.*` are shipped keys in `config/app-default-config.json`, and `scripts/verify-audit-chain.ts` exists. It is a decision record for something that runs.

Worth reading here for a reason this document keeps arriving at: a decision record is portable without the platform. Every one of these is adoptable as a __rule__ whether or not the deciding question below ever resolves — which makes it the clearest test yet of what "default to ngdpbase, improvements are filed" actually buys.

### The state of play, decision by decision

| ngdpbase decision | YourPHR today |
|---|---|
| D1–D2 — one posture, the active one; `baseline`/`hardened`/`regulated` are __advice__, not configuration | No posture concept. Also __no `security.profile` key was ever introduced__, so there is nothing to unwind — D7's removal is a mistake YourPHR skipped rather than a debt it carries |
| D3, D4, D16 — the posture is a curated __view__ over existing keys, shaped as a map so items merge per entry | Nothing. Admin → Configuration ([#458](https://github.com/jwilleke/yourphr/issues/458), [#472](https://github.com/jwilleke/yourphr/issues/472)) lists every key with a secret deny-list — a config browser, not a posture |
| D5 — edited from an admin dashboard section | Admin → Configuration exists; no posture section |
| D6 — restart requirement is __per item__, declared by the ingredient | Partly. See [#624](https://github.com/jwilleke/yourphr/issues/624) below — YourPHR has the concept, bundled into a flag doing three jobs |
| D8 — egress conflicts resolve by longest-prefix, deny wins a tie, nothing is fatal | No operator-configurable egress at all; `src/http/ssrf.ts` hardcodes the inward ranges |
| D9–D12 — a fatal configuration entry boots into __maintenance mode__, not a dead process | `src/cli/start.ts:31` calls `process.exit(EX_CONFIG)`. No maintenance mode: `grep -rl maintenance src/` returns `src/cli/migrate.ts` only. This is [#714](https://github.com/jwilleke/yourphr/issues/714) |
| D13 — deployment methodology is not an input to the design | Not stated anywhere. Relevant to [#641](https://github.com/jwilleke/yourphr/issues/641)'s three targets |
| D15 — the ingredient list, with secrets and plumbing excluded by rule | Not surveyed. Done below |
| D17 — the recommendations ship as __required pages__ inside the instance, carrying an accountability disclaimer | No page system. Same dependency as help, below |
| D18 — the posture section needs `admin-system` to __view__, not just to edit | Live gap. See below |
| D19 — posture changes audited; the posture recorded at boot and compared to the previous boot; hash-chained | None of it. See below |
| D20 — the instance never scores itself against a recommendation | Not stated. The temptation is far stronger here than in a wiki |
| D21 — the report states measurable facts and is not called `guarantees` | No report of any kind |
| D22 — audit storage isolation is operator advice, with its limits stated | `yourphr.audit.provider: "sqlite"` — the log lives in the same database file as the PHI |
| D23 — the witness: five ways it looks like it is working when it is not | No witness, no chain to witness |

### D6 answers one third of [#624](https://github.com/jwilleke/yourphr/issues/624), from a direction it had not considered

[#624](https://github.com/jwilleke/yourphr/issues/624) says the bootstrap flag is doing three jobs — raw-env, restart-required, secret. D6 is the finished argument for the second of them: __the ingredient declares whether it needs a restart__, maintained by hand and updated in the same commit as any consumer that changes when it reads.

The valuable half is the __rejection__. Comparing the running process against the configuration was considered and refused as over-built, with two concrete failure shapes: a boot snapshot reports a false restart-pending for consumers that re-read live, and the alternative — every consumer publishing the value it applied — is instrumentation across every subsystem to produce a flag a maintainer can simply write down. That reasoning transfers unchanged, and it is the design [#624](https://github.com/jwilleke/yourphr/issues/624) would otherwise have to derive.

The shipped encoding is worth copying too, because the obvious one is wrong: groups holding arrays of key names break per-item editing, since array merge replaces wholesale. ngdpbase ships a __map keyed by the ingredient__, each entry carrying `group` and `restart`, with removal expressed as `null`.

### D9–D12 are the worked answer to [#714](https://github.com/jwilleke/yourphr/issues/714)

[#714](https://github.com/jwilleke/yourphr/issues/714) — *"no way to say the instance is briefly not itself"* — was filed from the capability side. D9–D12 arrives at the same mechanism from the __failure__ side, and lands somewhere more useful:

- __D10's gate is a question, not a severity ranking:__ *can an administrator repair this through the admin UI?* Survivable means boot into maintenance mode with a link to the screen that fixes it; fatal means `process.exit`, reserved for when the machinery that would serve the repair is itself gone — configuration, the user and session layer, an unreadable data directory. A malformed deny rule is serious __and__ survivable; the distinction is whether stopping the process helps.
- __D11 folds `audit.on-failure: refuse-boot` into that path.__ Directly relevant: YourPHR's audit already refuses the boot (`src/app.ts:321`), which under D11 is the __worse__ shape. A process that exits on a bad audit configuration restarts, fails identically, restarts again, and the operator never gets an instance to repair it with. Readiness, not exiting, is what pulls it out of rotation.
- __D12 names the two changes that make it a repair path rather than a lockout:__ the not-ready gate must distinguish *starting* from *configuration-blocked* and pass `/admin` and `/login` in the second case, and the readiness endpoint must actually learn about the blocked state instead of reporting healthy.

One caution before copying: ngdpbase had to land [ngdpbase#1147](https://github.com/jwilleke/ngdpbase/issues/1147) first, because its maintenance mode had two sources of truth and a toggle that did not survive a restart. YourPHR building [#714](https://github.com/jwilleke/yourphr/issues/714) fresh does not inherit that debt — but it does inherit the lesson about which mistake to not make, and should read D12 before choosing a mechanism.

[#714](https://github.com/jwilleke/yourphr/issues/714) is currently P2. Nothing above changes that on its own, but it is a __dependency__ of any survivable-configuration-failure work, which is worth knowing before something else is scheduled that assumes one exists.

### D18 is a live disclosure question here, not a hypothetical

D18 requires `admin-system` to __view__ the posture section, departing from the usual view-with-`admin-read` pattern, and the concrete case it closes is __exactly YourPHR's shape__: a `demo-admin` role holding `admin-read` so a public demo can show every admin screen to visitors would, under the usual pattern, publish the instance's throttle thresholds, session flags and egress ranges to anonymous users.

YourPHR has a public demo instance and a read-only demo admin ([#644](https://github.com/jwilleke/yourphr/issues/644)), and Admin → Configuration is already shipped. So the question is answerable today: __what can the demo admin see on Admin → Configuration?__ The masking there is a deliberate deny-list — correct for its job, which is deciding what an already-authorised admin sees unmasked — and it says nothing about who may open the screen at all. `auth.throttle.max-failures` and `auth.throttle.window-seconds` together tell a reader how to pace a password-guessing attempt without tripping the lock, and they are not secrets, so no deny-list would cover them.

__Worth checking before adopting anything else from this document.__ It is a defect if it is true, and it is cheap to establish.

### D19, D21 and D23 are where the distance is largest — and larger than this document has been saying

YourPHR's `AuditManager` is not a general audit log. It is a __record-access counter__:

```ts
interface AccessEvent { actor_username: string; category: string; day: string; count: number; first_at: string; last_at: string; }
```

One row per `(actor, category, day)`, folded. Everything D19 builds on is therefore absent rather than merely unimplemented:

- __No event types__, so there is nowhere for a configuration change, a lifecycle event, or a token mint/renew/revoke to be recorded. The `AgentTokensManager` audit gap this document already notes is not an oversight in that manager; the log has no shape to hold it.
- __No `seq`, no `prevHash`__ — `grep -rl "chainSeq\|chainPrevHash" src/` returns nothing. There is no tamper evidence of any kind, so D19's strongest claim, D21's honesty about what may be promised, and all of D23 have no foundation to sit on.
- __Day-folding is itself a limit worth naming.__ A `count` per day cannot answer *which record was read* and cannot order two reads. For an access log whose stated purpose ([#614](https://github.com/jwilleke/yourphr/issues/614)) is telling a patient what was disclosed, that granularity is a decision nobody has revisited.
- __`audit.provider: "sqlite"` puts the log in the same database file as the PHI.__ D22's isolation advice has no analogue, and the coupling is tighter than ngdpbase's default, where `audit.provider.file.logdirectory` is already separate from the log directory.

__A correction to this document.__ *"Audit refuses to boot"* is listed above under what flows upward, and it is a genuine YourPHR strength — but it is a claim about the __availability__ of the log, not its __integrity__. ngdpbase now has both halves; YourPHR has one, and the one it lacks is the one a PHI store has the stronger reason to want. The two should not be totalled as a single advantage.

D23 is the most immediately useful part of the whole document regardless of any of this, because it is written from configuring the mechanism on a live instance and lists five ways a witness looks like it is working when it is not — including a witness that silently lands on the same volume as the log, which is __strictly worse than no witness at all__ since it converts an honest `unknown` into a confident `intact` backed by nothing.

### D15's ingredient survey, done for this tree

Applying D15's two exclusion rules — never a secret, never plumbing — to `config/app-default-config.json`:

| Group | YourPHR ingredients |
|---|---|
| Session and cookie | `web.secure-cookies`, `auth.session.sliding-seconds`, `auth.session.absolute-seconds`, `auth.trusted-proxies` |
| Identity and registration | `auth.signup.enabled`, `auth.password.min-length`, `auth.providers`, `auth.factors` |
| Login throttling | `auth.throttle.max-failures`, `auth.throttle.window-seconds` |
| Rate limiting | `auth.rate-limit.max-requests`, `auth.rate-limit.window-seconds` |
| Agent tokens | `auth.agent-token.enabled`, `.read-only`, `.default-ttl-hours`, `.max-ttl-hours`, `.max-per-user`, `.retention-days`, `.renewable`, `.max-renewals`, `.renew-window-hours` |
| Audit | `audit.provider` |
| Encryption at rest | `database.encryption.key`, `backup.encryption.key` — __presence only, never the value__ |

Two groups from ngdpbase's list have no YourPHR analogue, and both absences are correct: __content sanitisation__, because nothing here renders user markup server-side, and __egress ranges__, because the boundary is hardcoded rather than configured.

Two observations the survey produced, which is the point of doing one:

- __`yourphr.auth.factors` ships `["password"]`__ — the identical fact D15 calls out in ngdpbase, where it is what makes the absence of MFA visible rather than something a reader has to already know. Here it is [#507](https://github.com/jwilleke/yourphr/issues/507)'s subject, and a posture view is where it would stop being a survey item and become a stated property of the running instance.
- __`yourphr.auth.trusted-proxies` and `yourphr.web.secure-cookies` belong in the same group__, for D15's reason: they are read together, and showing one without the other hides half of a known interaction.

The cost of D16's map is lower here than it looks, because __this config file already carries three curated key lists__ — `yourphr.public` (an allow-list, because a mistake exposes a value to the internet), `yourphr.config.secret-keys` (a deny-list, because a mistake shows a value to an already-authenticated admin) and `yourphr.config.env-keys` (a map of key to owning variable). A fourth curated list in the same file is the mechanism it already uses three times, not a new idea to introduce.

### D17 is a second required-pages dependency

The `baseline`/`hardened`/`regulated` recommendations ship as __required pages rendered inside the instance__, one click from the section that edits the posture, each carrying a disclaimer that the operator alone is accountable for their configuration.

That places them on the same side of the deciding question as help. This document already found one shipped page answering a YourPHR gap — *"Using Tokens"*, which is [#695](https://github.com/jwilleke/yourphr/issues/695)'s minting-screen criterion. The posture recommendations are the second, and the pattern is now the argument rather than a coincidence: capability ngdpbase ships as __content__ costs YourPHR a page system it does not have.

### D20 matters more here than it does upstream

*The instance never scores itself against a recommended posture.* No drift warning, no compliance percentage, no badge.

ngdpbase's reason is that the thing being compared against does not exist — no authoritative value set, no two auditors agreeing on the same instance. __That reason is stronger for a PHR, and so is the pressure to ignore it.__ A personal health record is precisely where somebody will eventually ask for a `hipaa` profile value or a compliance score on the admin dashboard, and D2's objection applies exactly: naming a posture is a claim the label itself cannot establish. Adopting D20 as a standing rule costs nothing today and is much harder to adopt after the first such request has been agreed to.

### What this changes about the deciding question

__Nothing, and that is the finding.__ Every decision above is portable as a decision without adopting the platform, which is what a decision record is for. What is not portable by reading is the code behind D19, D21 and D23 — the chain, the witness, the verifier — and the maintenance-mode boot path behind D9–D12. Those are `src/framework`-shaped, which is the 34% column in the proportion table above, and they are reachable by the standing policy: copy the pattern, file the improvement.

The one exception is D17, which is required-pages and therefore lands on the far side of the same question help does.

## Help as a real document system — the `required-pages` mechanism

__Decided in session, 2026-08-30: help should be a real document system__ — operator-editable,
versioned, searchable. This is what ngdpbase already runs, and what it costs.

### How it works

- `required-pages/` holds __130 UUID-named Markdown files committed to the repo__ and shipped in the
  release image. Frontmatter carries `title`, `uuid`, `slug`, `system-category: documentation`,
  `user-keywords` and `author: system`.
- On install they __seed__ `data/pages/`. After install the directory is not read at runtime — the
  live page is the one under `data/pages/`, so an operator edit is a normal page edit.
- Once seeded they are __ordinary pages__: versioned by `VersioningFileProvider`, indexed by Lunr,
  themed, ACL'd, and queryable from markup — `[{Search system-category='documentation'}]`.
- Shipped text is application-neutral. Pages use `[{$applicationname}]`, so a derivative's docs name
  the derivative without a fork.

### The part that is genuinely hard, and already solved

`/admin/required-pages` is a __sync and diff screen__, not a reseed button. It compares the shipped
source against the live pages, counts what is new or modified, marks each `userModified`, warns when
an operator edits a page whose source lives in GitHub, and raises a notification —
*"X was edited by Y. Visit Required Pages Sync to review."*

That is the three-way problem — shipped docs, operator edits, a newer release — handled as a review
rather than a silent clobber. It is the reason this is worth adopting rather than approximating.

### It is not a portable module

Getting this without ngdpbase means rebuilding `PageManager`, a versioning storage provider, Lunr
indexing, the rendering pipeline (markdown plus plugin directives), page ACL, the sync/diff admin
screen and the notification that drives it. __That is building a wiki.__

So *"help should be a real document system"* is a decision to __run a wiki__. The only open question
is whose — and writing a second one is precisely what the governing document exists to prevent.

### The shape that keeps one patient-facing front end

The earlier objection was two front ends. It is answerable, because __ngdpbase exposes pages over a
JSON API__:

`GET /api/page-source/:page` · `GET /api/page-metadata/:page` · `GET /api/page/:id/versions` ·
`GET /api/page/:id/version/:v` · `GET /api/page/:id/compare/:v1/:v2` · `POST /api/preview`
(markdown to HTML) · `POST /api/page/ingest` · `POST /api/page/:id/rename` ·
`POST /api/page/:id/restore/:version` · `DELETE /api/page/:identifier`

So help content is __authored, versioned, searched and synced server-side__, and __rendered by
Angular in its own chrome__. The patient never crosses into EJS.

Split by audience rather than by technology, the surfaces stop competing:

| Audience | Surface |
|---|---|
| Patient | Angular — 37 pages: records, dashboard, sources, account, help |
| Operator | ngdpbase admin — 27 views, against YourPHR's current 4 |
| Help content | ngdpbase pages: shipped, seeded, versioned, searchable, sync-reviewed |

The admin trade is favourable rather than a loss: YourPHR has 4 admin pages
([#602](https://github.com/jwilleke/yourphr/issues/602), [#603](https://github.com/jwilleke/yourphr/issues/603),
[#604](https://github.com/jwilleke/yourphr/issues/604)); ngdpbase ships 27.

One shipped page is already the answer to an open YourPHR gap: `required-pages/` contains
__"Using Tokens"__, end-user documentation for agent tokens — which is
[#695](https://github.com/jwilleke/yourphr/issues/695)'s unmet criterion that *"the minting screen
states what leaves"*.

### What remains genuinely expensive

Unchanged by any of the above: __`src/server.ts` is 1,295 hand-rolled `node:http` lines__ carrying the
session cookie, the Bearer path, the agent-token gate, the demo gate and the access-log gate as inline
middleware, and ngdpbase is Express. That rewrite is the programme. Everything else is smaller than it
first appeared.

### Rejected alternative

__Run ngdpbase separately as a docs host.__ Two deployments, two URLs, two logins for the operator, and
the help content cannot be themed or searched with the product. Worse than either real option.

## The deciding question, now answered

__Does help want to be a real document system__ — operator-editable, versioned, searchable, changeable
without a release — __or is markdown shipped with the code enough?__

- If shipped-static is enough, [#632](https://github.com/jwilleke/yourphr/issues/632)'s own title is the
  answer: markdown in the repo, served over the API, rendered by Angular. Days of work, one front end,
  no platform adoption. The five backend wins above stay reachable by copying managers, which is the
  standing policy.
- If it wants to be a real document system, that is the one capability with no cheap substitute, and
  the platform question is worth reopening properly.

## Corrections made while writing this

Recorded because each was asserted confidently before being checked, and the pattern is the point.

| Claimed | Actually |
|---|---|
| The SSRF boundary makes cloning infeasible | Three real outbound call sites in core |
| Two theme systems; unification is its own project | Both sides are Bootstrap 5.3 with `--bs-*` custom properties |
| ngdpbase is not on Bootstrap (checked package.json only) | Bootstrap 5.3 by CDN, and the theme system is built on its variables |
| The twelve overlapping issues all transfer | About five transfer cleanly; the rest depend on the front-end decision |
| `architecture-principles-typescript.md` is missing | It moved to ngdpbase in `653a2441`; nine inbound references across eight files were never repointed — two of them told every agent to read it first |
| `repoForUser(username)` is what compartmentalises records | Gone from `src/` since [#608](https://github.com/jwilleke/yourphr/issues/608) — it survives only in two test harnesses. Managers narrow internally on `ctx.username`, so isolation survives a host swap untouched |

## Open, not decided

- The deciding question above.
- Whether the six audit gaps (see the session that produced this) are filed against YourPHR's own
  `AuditManager` or become *"adopt ngdpbase's"* — they are written differently depending on this
  document's outcome, so they are held.
- Repointing the six dangling references to the governing document.
- __Whether YourPHR's demo admin can read Admin -> Configuration__, which D18 of the security-posture
  record says it must not. Cheap to establish, and a defect if it is true.
- __Whether the access log's day-folding is the granularity [#614](https://github.com/jwilleke/yourphr/issues/614)
  wants.__ Raised by the D19 comparison; nobody has revisited it since the shape was chosen.
