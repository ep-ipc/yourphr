# Moving YourPHR onto ngdpbase — what it would take, and what it would buy

> __Status: analysis, 2026-08-30. Not adopted, nothing decided.__ Session notes from stepping through
> the question *"can YourPHR clone ngdpbase and work within it?"* Written down because the question
> keeps recurring and has been answered from structure rather than from evidence each time — see
> [yourphr#697](https://github.com/jwilleke/yourphr/issues/697), which argues it from repo layout alone.
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

Twelve issues, four of them P1.

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

- __`scripts/check-http-boundary.sh` and the SSRF guard (47 checks).__ ngdpbase has no outbound
  boundary at all, and its three call sites are unguarded.
- __`scripts/check-store-boundary.sh`.__ The governing document's own known-gaps table still records
  this lint as *"Not written. Until it exists, the invariant is documentation"* — YourPHR wrote it.
- __Audit refuses to boot.__ YourPHR never had the `NullAuditProvider` fallback ngdpbase had to fix in
  its #1118; `AuditManager` states the divergence deliberately.
- __Agent-token scopes as auditable access categories.__ A surface that cannot be logged cannot be
  scoped — structurally stronger than ngdpbase's *owner minus admin* rule.
- __Demo mode and its guards__, and per-IP rate limiting on the sign-in routes.

Two defects worth filing upstream, found while reading:

- __ngdpbase ships two contradictory audit rules.__ Its #1111 and the governing document say audit
  writes are fire-and-forget with a caught error — *"refusing a credential mint because the log failed
  is worse."* Its #1121 registry marks `token.mint` __critical tier__, meaning the record must land
  before the action. Both are in the tree.
- __Bootstrap is pinned twice__, at 5.3.0 and 5.3.3 in different views, by CDN rather than as a
  dependency.

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
| `architecture-principles-typescript.md` is missing | It moved to ngdpbase in `653a2441`; six inbound references were never repointed |
| `repoForUser(username)` is what compartmentalises records | Gone from `src/` since [#608](https://github.com/jwilleke/yourphr/issues/608) — it survives only in two test harnesses. Managers narrow internally on `ctx.username`, so isolation survives a host swap untouched |

## Open, not decided

- The deciding question above.
- Whether the six audit gaps (see the session that produced this) are filed against YourPHR's own
  `AuditManager` or become *"adopt ngdpbase's"* — they are written differently depending on this
  document's outcome, so they are held.
- Repointing the six dangling references to the governing document.
