# Medical source connection policy

**Code:** `backend/pkg/models/connection_policy.go`  
**Catalog fields:** `consent_policy`, `pre_connect_profile` on `ProviderCatalogEntry`  
**Patient projection:** `ConnectableProvider` (`requires_user_consent`, `pre_connect_profile`, `medicare_class`)

## Default (all medical-record connects)

| Step | Default |
|---|---|
| PP/ToS active opt-in | **Required** before any catalog connect |
| Pre-connect informed modal | **Yes** — generic medical-records copy |
| Disconnect / Remove data / combined | All sources (#437) |
| Attributions page | Always available |

Medicare / CMS Blue Button-class sources (URL/display auto-detect) additionally:

- Pre-connect profile **medicare** (claims-oriented copy)
- Forced patient label **Medicare** on production pickers
- CMS non-endorsement attribution (`docs/Attributions.md`)

## Modular overrides (when a provider cannot fit)

Set on the catalog entry (admin API create/update):

| Field | Values | Meaning |
|---|---|---|
| `consent_policy` | `required` (default), `skip` | Skip product PP/ToS gate only if truly necessary |
| `pre_connect_profile` | `auto` (default), `generic`, `medicare`, `none` | Which modal copy / skip modal |

Empty values resolve as **required** + **auto**.

### Examples

```json
{ "consent_policy": "required", "pre_connect_profile": "auto" }
```

```json
{ "consent_policy": "skip", "pre_connect_profile": "none" }
```

Rare escape hatch — document why in operator notes.

## Frontend flow

1. If `requires_user_consent` and user has not granted PP/ToS → block (Account Profile).  
2. If resolved `pre_connect_profile` ≠ `none` → show modular modal (Cancel / Continue).  
3. Continue → OAuth (popup in same click).  
4. Connected Sources → **Disconnect** (tokens only), **Remove data** (records only), or **Disconnect & remove data** (full teardown).

## Where UI lives

| Concern | Route |
|---|---|
| Connect + **Connected Sources** (per-provider cards, disconnect) | **`/sources`** (hosted SPA often under `/web/sources`) |
| PP/ToS consent, data-controls help, delete account | **`/account-profile`** |

Account Profile does **not** list one card per connected source — that stays on Sources.
