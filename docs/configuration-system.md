# Configuration system

**The rule: defaults ship in the binary, an instance overrides them in one file, a deployment may override that with environment variables — and nothing else is configuration.**

Everything below is either that rule, or a gap between it and what exists today. Gaps are marked **GAP** and each names its issue.

This page describes the mechanism. For *how to configure a deployment*, see [`deployment/README.md`](deployment/README.md).

## Layers

Lowest to highest precedence:

| Layer | Location | Who writes it |
|---|---|---|
| Shipped defaults | `backend/pkg/config/app-default-config.json`, embedded in the binary | developers, in a release |
| ~~`config.yaml`~~ | mounted at `/opt/fasten/config/config.yaml` | **GAP — being retired** |
| Instance overrides | `<data root>/config/app-custom-config.json` | the operator, via Admin → Configuration |
| Environment | `YOURPHR_*` | the deployment |

Later layers win. A key absent from a layer falls through to the one below.

> **GAP: `config.yaml` is a redundant fourth layer.** It predates the custom config store and does nothing the other layers cannot. Retiring it needs care — one of its keys (`cache.location`) differs from the shipped default, so deleting it in one step would silently relocate the cache.

### Why the defaults are embedded

`go:embed`, not a file on disk. A file could be missing, and `/opt/fasten/config` is covered by a ConfigMap mount in the reference deployment, so anything shipped there is invisible at runtime — the Dockerfile's `COPY config.yaml` is already shadowed that way. Embedding means the defaults cannot be absent or shadowed.

### Why the custom file holds only differences

`app-custom-config.json` contains **only what an operator changed**. It never absorbs the defaults.

Writing the merged view instead would freeze today's defaults into the instance: a later release that changed a default would silently not apply, and "what did I change?" would become unanswerable. Keeping it to differences makes that question a `cat`.

## Key format

- **Flat, dotted, lowercase.** `operator.contact_email`, never a nested `{"operator": {...}}`.
- **Values keep their case**, and may be strings, numbers, booleans, arrays or objects.
- Keys beginning with `_` are comments and are stripped on load.

Flat keys are the decision the rest rests on. With nesting, every object forces a judgement — is this a namespace to descend into, or a value the operator sets whole? The JSON shape cannot tell you: in ngdpbase, `ngdpbase.system-keywords` is an object that *is* a value, while `ngdpbase.server` is a namespace. Identical shape, opposite meaning. Putting the whole path in the key removes the question, and lets a value be an object without ambiguity.

It also matches the environment mapping exactly, for free.

### Environment mapping

`YOURPHR_` + the key uppercased, with `.` and `-` becoming `_`:

```text
operator.contact_email   ->  YOURPHR_OPERATOR_CONTACT_EMAIL
cda_converter.enabled    ->  YOURPHR_CDA_CONVERTER_ENABLED
```

Two unprefixed variables are bound explicitly because they describe how the app is reached from outside the container: `HOST_IP` and `HOST_PORT`.

### Environment references

A value may name a variable instead of containing one:

```json
"jwt.issuer.key": "${YOURPHR_JWT_ISSUER_KEY}",
"database.location": "${DATA_ROOT}/fasten.db"
```

- `$VAR` — **strict**. An unset variable is a startup error naming the key and the variable, because a bare reference asserts the value comes from somewhere.
- `${VAR}` — **lenient**. Resolves to empty when unset, which is what lets the shipped file name a secret without holding one.

This is how `jwt.issuer.key` is expressed. Unset resolves to empty, and empty already means "generate a real key and persist it" — so a stock install is secure with no operator action, and there is no placeholder sentinel to keep in sync.

## What is *not* configuration

Two things live outside this system on purpose.

**Provider catalog entries** are rows in the database — N providers, each with an endpoint, scopes, branding, `client_id` and `client_secret`. They are created and removed at runtime by an admin, and they are covered by database backups. Credentials in the config file would not survive a restore.

Sandbox and production Blue Button credentials are *provisioned* from `YOURPHR_SANDBOX_*` / `YOURPHR_PROD_BLUEBUTTON_*` at first start. The upsert is provision-only: once an entry has a `client_id`, the seed leaves it alone, so the database owns it thereafter. One-way flow, not a competing source.

**Backup state** — `.backup_settings.json`, `.backup_dest`, `.backup_health.json` — still has its own readers.

> **GAP: backup state should fold into the config store** — [#455](https://github.com/jwilleke/yourphr/issues/455). Deferred because it touches backup and restore, where a mistake loses data.

## Admin → Configuration

`/admin/config`, admin-only. Three tabs: current (merged), your overrides, shipped defaults.

### Where a value came from

Each row reports `default`, `custom`, or `environment`. This is the question the screen exists to answer — a value that quietly fell back to a default is otherwise indistinguishable from one set deliberately, which is what made [#397](https://github.com/jwilleke/yourphr/issues/397) and [#399](https://github.com/jwilleke/yourphr/issues/399) hard to diagnose.

### Keys governed by the environment cannot be edited

Environment outranks the custom store **on restart**. An edit would take effect immediately — viper's `Set` is the top layer — and silently revert on the next boot, when the store is merged beneath the environment.

So such a key shows source `environment`, names its variable, offers no Edit, and a write is refused with `409`. An edit that appears to work and quietly undoes itself is worse than one that is refused.

### Masking

Values named in the `secret` array are masked, and the real value is **not sent to the browser** — revealing one is a separate request for a single key, logged with the admin who asked. That is the difference between masked and not-sent: with CSS-only masking the value is already in the page for devtools, a screenshot, or any XSS.

`secret` is a short deny-list of five keys. It is deliberately **not** the inverse of `public`:

| Array | Shape | Because a mistake… |
|---|---|---|
| `public` | allow-list | …exposes a value to anonymous callers on the internet |
| `secret` | deny-list | …shows a value to an already-authenticated admin on their own screen |

Same structure, opposite safe default, because the consequences differ by orders of magnitude. Masking everything outside `public` hid 47 of 51 settings — including the listen port and the log level — which protects nothing and teaches an operator to click reveal without reading.

### Unknown keys are rejected on write

Only keys in the shipped catalogue can be set. A free-form "add any property" form makes a typo permanent: the key sits in the file forever, looks configured, and does nothing.

> **GAP: unknown keys are not detected on *read*.** A typo already in `app-custom-config.json`, or a misspelled `YOURPHR_*` variable, is silent. This is not hypothetical — the reference deployment's `config.yaml` set four keys that do not exist (`web.listen_port` is not `web.listen.port`), and nobody noticed. Should **warn**, not refuse: rejecting at startup would turn a removed key into a boot loop on upgrade.

## Differences from ngdpbase

The layering, the flat-key format, the comment convention and the environment references are all taken from [jwilleke/ngdpbase](https://github.com/jwilleke/ngdpbase) — read from `src/managers/ConfigurationManager.ts` and `config/app-default-config.json`, not from its docs. Three deliberate divergences:

**No namespace prefix.** ngdpbase requires `ngdpbase.` or `log4j.`; YourPHR keys are bare (`web.listen.port`). The prefix exists there to separate two configuration systems sharing one file. There is one system here.

**Unknown keys are rejected rather than prefix-validated.** ngdpbase accepts any name beginning `ngdpbase.` or `log4j.` — enforced in the route layer (`WikiRoutes.ts`), not in `ConfigurationManager`, which accepts anything it is handed. YourPHR checks against the catalogue instead. Stronger, and only possible because the catalogue is complete and a test enforces that.

**No deep merge — yet.** ngdpbase merges objects recursively and merges arrays by `id`. YourPHR replaces whole values, because no setting currently *has* an object value. Worth adopting when the first one appears; not before, since it is the one part carrying real complexity.

## Guards

Tests that keep the above true rather than aspirational:

| Guard | What it prevents |
|---|---|
| every key read in code exists in the catalogue | a setting silently reading as a zero value |
| every key is lowercase and flat | a mixed-case key that appears to work while resolving elsewhere |
| no `os.Getenv` outside an allowlist | configuration read behind the config layer's back ([#455](https://github.com/jwilleke/yourphr/issues/455)) |
| `/api/instance/public` exposes only the allow-list | a credential reaching an anonymous caller |
| masking covers under a quarter of settings | drifting back to masking everything |

## Open decisions

| | Issue |
|---|---|
| Retire `config.yaml` | — |
| Warn on unknown keys from the custom file and the environment | — |
| Fold backup state into the store | [#455](https://github.com/jwilleke/yourphr/issues/455) |
| Should `YOURPHR_SANDBOX_*` be catalogued, so the unknown-key check is clean and they appear on the Admin screen? | — |
| Move ordinary settings out of environment on the reference deployment, leaving bootstrap and secrets | — |

The last one is the judgement call. On the reference deployment, environment carries one bootstrap variable, seven secrets, and five ordinary settings. The five could live in the config store and become editable — at the cost that GitOps would no longer describe them. That is the trade between *declarative deployment* and *operator-editable app*, and it should be chosen rather than drifted into.
