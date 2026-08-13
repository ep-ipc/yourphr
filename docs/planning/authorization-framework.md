# Authorization framework — planning

> **Status: planning, not decided.** Nothing here is built. This records the shape we are converging on, the prior art it draws from, and the questions still open. Started 2026-08-13.

## Scope

**Authorization only** — what an already-identified caller is *allowed to do*. Proving *who* someone is belongs to [`authentication-framework.md`](authentication-framework.md), which explicitly deferred this half. This is that thread returning.

The trigger was concrete: on the public demo, every write button on the admin screens looks live, and the read-only demo admin learns they are refused by pressing them ([#527](https://github.com/jwilleke/yourphr/issues/527) reported two bugs found exactly that way). The button and the rule that governs it are decided in two different places, in two different languages, with no shared vocabulary between them. That is the problem worth solving; the demo is only where it first became visible.

**Explicitly out of scope: per-user data isolation.** Repository queries scope records to their owner, and that is a different mechanism from a permission check — it is a `WHERE user_id = ?`, not a yes/no on an action. Modelling row ownership as permissions is how RBAC systems turn into query planners. It stays where it is.

## Where we are today

| Mechanism | Where | Covers |
|---|---|---|
| `RequireAuth` | `middleware/require_auth.go` | Is there a valid session at all; token generation check ([#508](https://github.com/jwilleke/yourphr/issues/508)) |
| `handler.IsAdmin(c)` | `handler/auth.go:29`, called from 6 handler files | Admin-only actions — config, database, users, instance, metrics |
| `requireAdmin(c)` | `handler/provider_catalog.go:55`, called 6 times | The same check, written twice |
| `RestrictDemoAdmin` | `middleware/demo_admin_guard.go` | Read-only demo admin, default-deny by HTTP method ([#516](https://github.com/jwilleke/yourphr/issues/516)) |
| `RestrictDemoAccount` | `middleware/demo_guard.go` | Shared demo user ([#496](https://github.com/jwilleke/yourphr/issues/496), [#514](https://github.com/jwilleke/yourphr/issues/514)) |
| `AuthService.IsAdmin()` | `frontend/src/app/services/auth.service.ts` | The browser's independent guess at what the backend will allow |
| Repository scoping | `database/gorm_common.go` | Per-user record isolation — out of scope here, listed for completeness |

**25 in-handler admin gate call sites across 7 files, reached through two duplicate helpers.** Two roles exist: `user` and `admin` (`pkg/constants.go:82`).

### What today's shape costs

- **The rule is expressed as "is this person an admin", never as "is this action permitted".** So there is no way to answer "may this session delete a provider?" without running the request. That is precisely the question the UI needs answered *before* drawing the button, which is why the frontend ended up guessing.
- **Two helpers already drifted into existence** for one concept. A third role would need 25 sites revisited, each an independent chance to be wrong.
- **The demo rules are expressed in a different dimension entirely** — HTTP method and path prefix, not action. That was the right call under the circumstances (see the [#514](https://github.com/jwilleke/yourphr/issues/514) note below) but it means two separate systems answer overlapping questions, and neither can see the other.
- **The frontend holds an independent copy of the policy.** `IsAdmin()` is a guess. When it disagrees with the server, the user meets a refusal they were invited to trigger.
- **Access tokens carry scopes with no ceiling.** A token's authority is not intersected with its owner's, so scope means whatever each handler happens to check.

## Prior art

### `jwilleke/ngdpbase` — `src/context/WikiContext.ts`, `ACLManager`, `UserManager`, `PolicyEvaluator`

Ours, and the model this proposal is derived from. The relevant surface:

- `WikiContext` is **request-scoped** and carries `userContext` (username, roles, authenticated).
- `hasRole(...names)` — a cheap roles-array check, no policy consulted.
- `hasPermission(action)` — the canonical path, delegating to `UserManager.hasPermission` and from there to `PolicyEvaluator`.
- `canAccess()` — per-page ACLs via `ACLManager`.
- `_permissionCache: Map<string, Promise<boolean>>` — the same question asked twice in one request is free.

Two details worth carrying over verbatim:

- **The agent-token scope ceiling** (`UserManager.ts:678`). A token scoped `page-read` cannot create pages *even if its owner could*, and the comment there is explicit that this is a **second enforcement point, not a duplicate** — capability checks reach `UserManager` without ever touching `ACLManager`, so a ceiling in one does not cover the other. Our access tokens need the same, and the lesson is that "where does this check actually run" has to be answered per path, not per intention.
- **`AuthenticateResult.viaToken` deliberately omits roles** — authority is resolved live from the user record so no credential holds a snapshot of it. Already noted in the authentication doc; it matters more here.

**One thing not to inherit:** the permission vocabulary there is inconsistent — `page-create` and `user-read` in some places, `page:read` and `admin:system` in others. Pick one convention and hold it.

### The structural difference that matters

**ngdpbase renders on the server.** `WikiContext` is request-scoped, and the template asks `hasPermission('page:edit')` *while drawing the button*. Rendering and enforcement are the same process reading the same object, so they cannot disagree.

**YourPHR is an Angular SPA against a JSON API.** The button is drawn in the browser; enforcement is in Go; a network sits between. The single context therefore splits into two:

| | Server | Client |
|---|---|---|
| Scope | Request | Session |
| Authority | **The decision** | A projection of it |
| Governs | Whether the handler runs | What gets drawn |
| If they disagree | Server wins, always | User meets a refusal — a cosmetic bug |

They stay honest by speaking the **same permission strings**, named once in Go and shipped to the UI. That is the whole contract, and it is what today's `IsAdmin()` guess lacks.

## Proposed shape

```go
// Permission is an action, not a role. Named once, here.
type Permission string

const (
    PermissionConfigRead        Permission = "config:read"
    PermissionConfigWrite       Permission = "config:write"
    PermissionConfigRevealSecret Permission = "config:reveal-secret"
    PermissionUserList          Permission = "user:list"
    PermissionUserResetPassword Permission = "user:reset-password"
    PermissionProviderCatalogDelete Permission = "provider-catalog:delete"
    PermissionDatabaseBackup    Permission = "database:backup"
    PermissionDatabaseBrowse    Permission = "database:browse"
)

// AuthContext is request-scoped, computed once by middleware, and carried on the gin.Context —
// the WikiContext analogue. Never serialised into a token.
type AuthContext struct {
    Username    string
    Role        pkg.UserRole
    Permissions map[Permission]bool // resolved, not re-derived per question
    ViaToken    *TokenGrant         // when the caller is an access token; scopes CEIL the set above
}

func (a *AuthContext) Can(p Permission) bool
```

Routes declare what they require, rather than each handler asking:

```go
secure.DELETE("/admin/provider-catalog/:id", middleware.Require(PermissionProviderCatalogDelete), handler.DeleteProviderCatalogEntry)
```

### The invariant that matters

**The client's permission set is advisory. It decides what to draw and nothing else.**

Anyone can edit it from the browser console, so a UI that "checks permission before calling the API" has performed a suggestion, not a control. Every request is evaluated independently, server-side, from the user record — the same rule the demo guard follows today, where a disabled button is decoration and the middleware is the control. Getting this backwards converts a UI improvement into an authentication bypass on a product holding medical records.

### Default-deny survives the migration

[#514](https://github.com/jwilleke/yourphr/issues/514) is the reason this is non-negotiable. The demo guard was originally written by naming the dangerous routes; it missed two — change password and delete account — and any visitor could lock every user out of the public demo permanently. The replacement inverted the direction, and that inversion must survive: **a route with no declared permission is refused, not allowed.** Not logged, not warned — refused. A framework that fails open is worse than the 25 scattered checks, because it looks organised while being wrong.

### Where the demo rules land

`RestrictDemoAdmin` becomes a permission set — the demo admin resolves to reads only — rather than a method-and-prefix filter. Two constraints on doing that:

- It does not move until parity is proven route by route, and the existing guard stays in place until then. The method filter is coarse but it is *currently correct*, which is worth more than elegance.
- Even afterwards, the group-level default-deny stays. Belt and braces is the appropriate posture for a public host running an admin API.

## Traps specific to this codebase

- **Do not put permissions in the JWT.** They would go stale the moment a role changed, and a demoted admin would keep their buttons — and their access — until the token expired. Resolve live per request; `token_generation` ([#508](https://github.com/jwilleke/yourphr/issues/508)) already forces a client to re-fetch when authority changes.
- **The migration must not silently widen.** Every mapping starts from what the route does *today*. A route that is admin-only now maps to an admin permission now, even where a narrower one looks obviously right — narrowing is a second, separate change with its own test.
- **Row-level isolation is not RBAC.** `WHERE user_id = ?` stays in the repository. `user:read-records` as a permission would be a permission that is always true and explains nothing.
- **Two enforcement points already exist and will multiply.** ngdpbase learned this the hard way (`UserManager.ts:678`): a ceiling applied on the resource path did not cover the capability path. Enumerate the paths a request can take to reach a handler *before* deciding where the check goes.
- **The frontend's `IsAdmin()` must be deleted, not left alongside.** Two sources of truth for the same question is the bug we are fixing; leaving the old one in place ships the bug with extra steps.

## Settled so far

- Permissions are actions, named `resource:action`, one convention, defined once in Go.
- The server-side context is request-scoped and authoritative; the client's copy is session-scoped and advisory.
- Unmapped route means refused.
- Access-token scopes are a **ceiling** on the owner's permissions, never a grant.
- Per-user data isolation stays in the repository layer and is not modelled as permissions.
- The existing demo guards stay until per-route parity is demonstrated.

## Open questions

- **Where does the client fetch its projection?** Fold it into `GET /api/secure/account/me`, or a dedicated endpoint? `/me` means one fewer request and no chance of the two disagreeing; a dedicated endpoint is easier to cache and to reason about.
- **Do permissions attach to roles, or directly to users?** Two roles today, and a family instance may eventually want "my daughter can see her own records but not manage sources". Role-only is simpler and probably right until a third role actually exists.
- **Does a permission carry a reason string for the UI?** `provider-catalog:delete` denied → "disabled in the public demo" is much better copy than a generic refusal, but it puts presentation text in the policy layer.
- **How is this tested so the table cannot drift from the routes?** A test that walks the registered routes and asserts each declares a permission would make an unmapped route a build failure rather than a runtime refusal. Probably the highest-value single test in the whole design.

## Sequencing

Each phase is its own issue, linked with blocked-by — not a checklist inside one issue.

1. **Permission vocabulary and table in Go.** No behaviour change; nothing consumes it yet. Deliverable is the named set plus the role-to-permission mapping that reproduces today's rules exactly.
2. **Request-scoped `AuthContext` and `Require(...)` middleware**, with the route-coverage test from the open questions above. Still no behaviour change: mappings reproduce current gates.
3. **Retire the 25 call sites** and both duplicate helpers, route by route, one PR per handler file so a regression is bisectable.
4. **Publish the projection** to the client and consume it in the frontend; delete `AuthService.IsAdmin()`.
5. **Fold the demo rules into permissions**, keeping the group-level default-deny.
6. **Access-token scope ceiling**, intersecting token scopes with the owner's permissions.

**Not blocked by any of this:** disabling the demo's dead admin buttons using the `demo.admin.session` flag that already exists. It is about an hour of work, and phase 4 deletes it. Shipping the interim fix is not wasted effort — it is the thing that stops the demo teaching visitors that the app is broken while the framework gets built.

## Related

- [`authentication-framework.md`](authentication-framework.md) — the other half; explicitly deferred authorization to here
- [#527](https://github.com/jwilleke/yourphr/issues/527) — the reporting bugs that surfaced this
- [#516](https://github.com/jwilleke/yourphr/issues/516) — read-only demo admin, the current default-deny guard
- [#514](https://github.com/jwilleke/yourphr/issues/514) — why default-deny is not negotiable
- [#508](https://github.com/jwilleke/yourphr/issues/508) — `token_generation`, the mechanism for forcing a permission re-fetch
- `jwilleke/ngdpbase`: `src/context/WikiContext.ts`, `src/managers/UserManager.ts`, `src/managers/ACLManager.ts`
