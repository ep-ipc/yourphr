# Third-party attributions

**In-app:** `/attributions` (authenticated)  
**Registry (source of truth for UI copy):** `frontend/src/app/models/fasten/attributions.ts`  
**Related issues:** [#428](https://github.com/jwilleke/yourphr/issues/428) (CMS Blue Button notice), future partner notices.

## Approach

YourPHR will integrate multiple third-party APIs and data sources (CMS Blue Button first; others over time). Each may require a **non-endorsement** or attribution statement that must not be buried only in product Terms.

We use **one attributions catalog** for all partners, not a one-off hardcode per vendor forever.

| Layer | Purpose |
|---|---|
| **Canonical registry** | Structured list of notices (`id`, title, full text, optional URL, `contexts` when to show) |
| **Attributions page** | Full list — every notice readable in one place (`/attributions`) |
| **Contextual display** | Same text (or a short pointer) on the journey CMS/demo requires — e.g. Medicare connect |
| **Footer / Account Profile** | Discoverable link to the full page |

### What this is not

- **Not** product Privacy Policy / Terms of Service (those live at yourphr.org and Account Profile consent — [#427](https://github.com/jwilleke/yourphr/issues/427)).
- **Not** FHIR `Consent` resources (clinical/privacy directives — see [build.fhir.org Consent](https://build.fhir.org/consent.html#6.2)).
- **Not** operator contact (Admin Instance card).

### Contexts (`contexts` field)

| Context | Meaning |
|---|---|
| `attributions-page` | Always listed on `/attributions` |
| `medicare-connect` | Show near patient-facing Medicare / Blue Button connect |
| `footer` | Optional short link or line in app footer (full text stays on the page) |

Add new partners by appending an entry to the registry and choosing contexts. Prefer **not** dumping every full notice into the global footer.

## Current entries

### CMS Blue Button APIs (#428)

Required by [Blue Button API Terms of Service — Attribution](https://bluebutton.cms.gov/terms/):

> This product uses the Blue Button APIs but is not endorsed or certified by the Centers for Medicare & Medicaid Services or the U.S. Department of Health and Human Services.

- **Contexts:** `attributions-page`, `medicare-connect`
- **Patient-facing source label** remains a separate concern ([#429](https://github.com/jwilleke/yourphr/issues/429) — label as **Medicare**, not “Blue Button”).

## Adding a new attribution

1. Add an object to `ATTRIBUTIONS` in `frontend/src/app/models/fasten/attributions.ts`.
2. Set `contexts` appropriately (always include `attributions-page`).
3. If a connect/demo path must show it, wire that context in the relevant page (same pattern as Medicare on Sources).
4. Mention the partner in this doc’s “Current entries” section.

## Demo checklist (CMS)

- [ ] Open `/attributions` — CMS sentence visible  
- [ ] Open `/sources` with a Medicare-class provider — CMS notice visible near connect  
- [ ] Footer (or Account Profile) links to Attributions  
