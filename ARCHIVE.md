# ARCHIVED — `feature/chat`

**Status:** archived, not merged, not scheduled to merge. Kept for reuse.
**Archived:** 2026-09-11
**Tip at archival:** `0ebc7596c`
**Base:** 9 commits off `main`
**Supersedes:** the chat feature was made redundant by the MCP server
(`scripts/mcp-server.ts`, yourphr#657) on `main` — a patient now reaches their own
records through whichever AI client they already run, under an agent token they
minted themselves.

This file exists because the *code* on this branch is the cheap part. The expensive
part is the set of live failures it was shaped by, most of which are recorded only as
comments inside files that will otherwise never be opened again. Several of those
failures apply unchanged to the MCP server, which has not yet been corrected for them.

---

## Why this branch was retired

Chat and the MCP server answer the same question — "let a person ask their own records
something in plain language" — and the MCP server answers it with less standing
surface: no model endpoint for the operator to run, no prompt to maintain, no
transcripts to encrypt, no chat page, no conversation-ownership table. The client the
patient already trusts supplies the model and holds the conversation.

What this branch had that MCP does not is **a controlled prompt**. That difference is
the source of most of the portable findings below: this branch could fix a bad answer
by editing `SYSTEM_PROMPT`, and the MCP server cannot. Anything it wants to enforce has
to live in a tool description, a resource, or the shape of what it returns.

---

## What is on this branch

Chat proper (retire with the branch):

| Path | What |
|---|---|
| `src/app/managers/ChatManager.ts` | The one door. Owner seam at `who(ctx)`, retrieval through the Records manager rather than around it. |
| `src/app/providers/LocalChatProvider.ts` | Retrieval + prompt assembly + one call to the operator's model. No sidecar. |
| `src/app/providers/BaseChatProvider.ts` | Capability interface with the owner seam **in the interface** — `userId` on every method. |
| `src/app/providers/BaseChatConversationsProvider.ts`, `SqliteChatConversations.ts` | Conversation ownership + transcripts, in the app database (encrypted at rest). |
| `frontend/src/app/pages/chat/*`, `services/chat.service.ts`, `auth-guards/chat-feature.guard.ts` | The chat page. |
| `src/server.ts` (chat routes), `src/app.ts` (`chatProviderFor`) | Wiring. Inert unless an operator binds a provider. |
| `config/app-default-config.json` | `yourphr.chat.*`, off by default. |
| `docs/deployment/chat.md` | Operator documentation. |
| `scripts/chat-live.ts` | Live harness: boots the app, imports a Synthea bundle per account, serves the built frontend. |

**Independent of chat, and still wanted on `main`** — this should be lifted out
separately rather than archived:

| Path | What |
|---|---|
| `src/http/ssrf.ts`, `guarded-fetch.ts`, `index.ts` | `allowHosts`: a **named-host** exemption from the internal-address refusal, for a service the operator runs on their own network. Three properties keep it from becoming the hole `allowInternal` would be — a set of names not a switch, supplied once at construction and stripped from per-request options, matched on the hostname before resolution. Also `OutboundHttp.request`, and `DELETE` added to the non-GET redirect refusal. |
| `scripts/ssrf-tests.ts` | Its harness. |

Also present but **excluded from this review** — being submitted upstream as its own PR:
`src/multipart/`, `SourcesManager.importBundle`, `scripts/upload-tests.ts`
(commit `9832413db`, also on `feature/manual-upload`).

---

## Findings that apply to the MCP server

Ranked. Each names the file on this branch that carries the reasoning in full.

### 1. Multi-word queries return nothing — a live bug in MCP today

`ftsQuery` in `src/app/providers/record-text.ts` (on `main`) joins terms with **`AND`**:

```ts
return terms.map((t, i) => `"${t.replace(/"/g, '')}"${i === terms.length - 1 ? '*' : ''}`).join(' AND ');
```

Correct for a search box, where typing more words means "narrow it down". Fatal for a
model. `search_records({query: "vaccination immunization vaccine shot"})` demands a
record containing **all four** words; nothing does. The tool returns no results and the
model reports the patient has no immunizations.

This branch hit it and split the search: see `LocalChatProvider.search` — one index
query per term, merged, **ranked by how many terms a record matched**. Term-coverage
ranking falls out for free and beats a flat `OR`: a record matching "seizure" *and*
"clonazepam" outranks one matching only "medication".

> Every question came back "I do not have that information" until this was split.

**Port:** split `query` on whitespace in `search_records`, one request per term, merge
by coverage. The server-side `AND` join should stay as it is — it is right for the
dashboard.

### 2. The index is filed under FHIR's words, and no model guesses them

Asked "what vaccinations have I had?", a model with no idea what the index contains
produced `vaccination immunisation vaccine shot jab` — five reasonable words, none of
which appear in a record. The index says **`Immunization`**, American spelling, because
that is what FHIR calls the resource. The patient had twelve.

This branch fixed it by naming the vocabulary in the prompt that generates terms —
`RECORD_VOCABULARY` and `TERMS_PROMPT` in `LocalChatProvider.ts`. Costs nothing and
removes a whole class of near-miss: synonyms, British spellings, and the patient's word
for a thing versus the record's.

**Port:** MCP has no prompt of its own — the *client's* model chooses the terms. So this
belongs in the `search_records` **tool description**, which currently does not say that
matching is word-for-word, nor which words records are filed under.

### 3. Billing swamps the index

`NOT_CLINICAL` in `ChatManager.ts` excludes `Claim`, `ExplanationOfBenefit`, `Coverage`,
`PaymentNotice`, `PaymentReconciliation`, `Invoice`, `ChargeItem`, `Account`.

The measurement that produced it, from the Synthea bundle this was first tried against:

> ExplanationOfBenefit and Claim were **10,917 of roughly 20,000 indexed characters** —
> more than half the index — against **193 characters** for all three of the patient's
> actual diagnoses. Asking "what conditions have I been diagnosed with" spent four of
> its ten slots on untitled claims.

Retrieval is a fixed number of records, so every billing row that scores is a clinical
record that does not. `search_records` returns them today.

**Port:** filter on `source_resource_type` in the rendered hits, or add an
`include_billing` parameter defaulting to false.

### 4. Search hands out references the model cannot follow

`search_records` returns `MedicationRequest/abc123` and there is **no tool to read that
record**. The model gets a citation it can quote but not open.

`RecordsManager.searchStored` on this branch is the backend primitive for the fix: it
returns full `StoredRecord`s rather than the dashboard's list shape, which is precisely
the difference between "something that renders a result row" and "something that needs
to read what the record says".

**Port:** `searchStored` to `main`, then a second MCP tool — `read_record(type, id)` —
over a categorised GET so it inherits the same default-deny gate and access-log line.

### 5. An example value in a prompt is, to the model, just more context

From the comment above `SYSTEM_PROMPT` in `LocalChatProvider.ts`:

> The prompt this replaces carried `"(e.g.,'March 3, 2019')"` to illustrate date
> formatting, and a model asked when a medication was prescribed answered "around
> March 3, 2019" when the real date was **21 May 2019** — it had taken the date out of
> its own instructions and presented it as a fact about the patient.

The MCP server's `GROUNDING` constant and its `initialize` instructions are milder than
this branch's prompt and are missing two clauses that were earned:

- *never supply a date, dose, name or value that is not written in the records*
- *do not mention field names, data formats, record types, identifiers or codes*

**Port:** into `GROUNDING` and the `instructions` string. Audit both for example values
while there.

### 6. Hit rendering leaks FHIR at the answering model

`mcp-server.ts` renders each hit as:

```
- MedicationRequest/abc123: Title (date) — snippet
```

Raw resource type and id, inline — which is exactly what finding 5's second clause tells
a model to suppress, and exactly the confusion the `KIND` map in `ChatManager.ts` was
built to remove:

> Asked "what conditions have I been diagnosed with", the model answered with a list of
> blood-test names — because nothing in the retrieved text distinguished a diagnosis
> from a laboratory measurement. "Erythrocyte distribution width" reads exactly like a
> finding if you cannot tell what kind of record you are looking at.

`KIND` maps `Condition` → `Diagnosis`, `Observation` → `Test result or measurement`,
`MedicationRequest` → `Medication prescribed`, and so on. Naming the kind fixes both
halves at once: retrieval matches "diagnosed" against "Diagnosis", and the model can
tell the two apart when it answers.

**Port:** `KIND` into the hit renderer. Keep the id as a follow-up reference — finding 4
makes it usable — but out of the prose.

### 7. The retrieval cap default deserves a deliberate decision

`yourphr.chat.retrieval.max-records` is **10**, and the config comment carries why:

> 5 records gave a clean correct answer, 10 correct with one stray item, **20 made it
> refuse outright**, and 30 made it list blood tests as diagnoses. More context is NOT
> better — a smaller model degrades as it grows.

`search_records` defaults to `limit: 20` and permits 100.

**Caveat, and it is a real one:** that was measured against a 4B model. In MCP the
answering model is the *client's*, usually much larger, so the numbers are not binding.
But the default currently sits at the value that broke a small model, which is worth
choosing on purpose rather than inheriting.

### 8. Two lessons filed for later, if MCP ever holds state

Neither applies today — the MCP client owns the conversation. Both come from
`SqliteChatConversations.ts`:

- **Order turns by a sequence, not a timestamp.** A question and its answer land in the
  same millisecond often enough that a clock cannot separate them; the design this
  replaced ordered on a whole-second timestamp and duly returned the answer above the
  question that produced it.
- **Put the ownership check inside the statement, not in front of it.** `append` uses
  `INSERT ... WHERE EXISTS (SELECT 1 FROM chat_conversations WHERE conversation_id = ?
  AND user_id = ?)`, so a turn cannot be written into a conversation the account does
  not own, whatever the caller believed.

---

## What does not port

- **Conversations, transcripts, the ownership table, `ChatManager`, the routes, the
  Angular page.** The MCP client holds the conversation. This is most of the branch.
- **The `available` / `degraded` / `unavailableReason` discipline.** MCP already does
  this *better*: its 401 and 403 handlers name the exact scope to tick when minting a
  replacement token. Nothing to take.
- **The `allowHosts` SSRF exemption.** Wanted on `main`, but not as an MCP change — the
  bridge lives in `scripts/` and uses raw `fetch` by design, because `check:boundary`
  refuses `fetch` under `src/` (Node's fetch is undici and ignores the guarded DNS
  lookup that is the SSRF control).
- **Multi-account isolation testing.** `scripts/mcp-tests.ts` on `main` already has it,
  and with teeth: both accounts are prescribed the same drug, so a broken owner seam
  fails the test rather than passing vacuously.

---

## Reusing this branch

It is a normal branch; nothing here is rewritten or squashed.

```bash
git log --oneline main..feature/chat      # the 9 commits
git diff main...feature/chat              # the whole delta
git show 053a66024                        # the native provider, in one commit
```

To lift one piece out without the rest — the SSRF work is the likely one:

```bash
git checkout -b chore/ssrf-allow-hosts main
git checkout feature/chat -- src/http/ scripts/ssrf-tests.ts
```

Note that `../.gitmodules` in the `ipc-health` superproject pinned this branch
(`branch = feature/chat`, commit `0ebc7596c`). If that pin has since moved to `main`,
this branch is referenced by nothing and will only be found by someone who knows to
look for it — which is what this file is for.

---

## Appendix: the Go lineage, deleted 2026-09-11

This chat feature had an earlier life on the **Go** stack, as a port of upstream
`fastenhealth/fasten-onprem#594` backed by a Typesense sidecar. Three refs carried it:

| ref | what | tip |
|---|---|---|
| `origin/feature/chat-search` | the squashed Go implementation | `1cdf802b9` |
| `feature/chat-search` (local only) | the same squash replayed onto the TypeScript trunk — it **re-added the `backend/` directory that `main` had deleted**, which is why it was never usable | `1bae58fcd` |
| `bb1408cc` | the 193-commit pre-squash history, reachable from **no ref** and surviving only until the next `gc` | `bb1408cc8` |

All three were Go-based — `backend/`, `go.mod`, no `src/` — and the project is not
returning to Go, so all three were deleted rather than archived. The branch this file
lives on is the TypeScript rewrite that replaced them.

Most of what that lineage learned is already carried in the code here: the
first-document schema inference that "refused six records of the very first bundle"
(see `LocalChatProvider.ts`), the browser holding the search engine's API key with no
owner filter at all (see `BaseChatProvider.ts`), and the measured
`max_bytes` of 57344 over the 28672 default (see `config/app-default-config.json`).

**Two findings were NOT carried, and still apply to the current stack:**

1. **`sort_title` was indexed before FHIRPath extraction populated it,** so every
   resource was indexed with an empty title and keyword search never matched anything.
   An ordering bug between extraction and indexing, not a search bug — and `main` still
   has both an index and a `sort_title`.
2. **An unhandled rejection inside an `APP_INITIALIZER` blocks Angular bootstrap
   entirely.** `GET /settings` 404s on every fresh install, because the backend is in
   standby until an encryption key is set and does not register the route — which left
   first-run showing a permanent blank page instead of the setup wizard. The fix was to
   catch and default to `{}`.

The full commit message is reproduced below, since deleting the refs makes every SHA in
it unresolvable. It is the most detailed record of that work that exists.

> feat(search): AI-assisted search & chat, ported and hardened for yourphr
>
> Squashed history of the search/chat feature branch (previously feature/chat,
> feature/chat-clean, feature/record-search, feature/conversation — ~250 commits
> of iteration, merges, and reverts) into one commit for a clean history on
> main. The pre-squash history is preserved at branch
> backup/feature-chat-search-pre-squash and at the previous tip of
> feature/chat-search (bb1408cc) if anything needs to be traced back.
>
> Ports AI-assisted search & chat from upstream fasten-onprem, originally
> developed at TechStackApps/fasten-onprem#feature/chat-clean and proposed
> upstream as fastenhealth/fasten-onprem#594
> (https://github.com/fastenhealth/fasten-onprem/pull/594). Re-architected here
> for yourphr's env/JSON config system (no config.yaml — removed in #470/#474),
> Angular 20, and the current Go toolchain, rather than the PR's Angular 17 /
> config.yaml baseline.
>
> - Typesense-backed full-text/vector search over imported FHIR resources
>   (`/resource/summary`, the dashboard search box).
> - An LLM chat page (`/chat`) backed by any vLLM/OpenAI-compatible endpoint
>   (verified against a real remote Ollama instance).
> - New `search.*` config keys (`backend/pkg/config/app-default-config.json`),
>   off by default; `search.api_key` masked as a secret.
> - `typesense` service added to `docker-compose.yml` / `docker-compose-prod.yml`.
> - Both gated by `SearchFeatureGuard` / `ChatFeatureGuard` reading the new
>   settings.
>
> - `sort_title` was indexed into Typesense BEFORE FHIRPath extraction
>   populated it, so every resource indexed with an empty title and keyword
>   search never matched anything.
> - `GET /api/settings` read `cfg.Get("search")` — the parent key — which
>   doesn't see env-var overrides on its children the way a direct leaf read
>   (`cfg.GetBool("search.enabled")`) does, so the frontend always saw
>   disabled/default values regardless of configuration.
> - The reindex-on-migrate path logged "already indexed, skipping" but had no
>   branch that actually skipped, re-indexing every resource on every restart.
> - A logger call passed printf-style args to `Logger.Print`, which doesn't
>   format them.
> - Two independently-added `FastenApiService.searchResources()` methods
>   (different signatures, different backends) collided under the same name;
>   the Typesense one is renamed `searchTypesenseResources()`.
> - ~36 components ported from the PR were missing `standalone: false`,
>   defaulting to Angular 20's `standalone:true` and failing to compile inside
>   the NgModules that declare them.
> - The frontend's `TypesenseService` connects to Typesense DIRECTLY from the
>   browser, which yourphr's stricter networking posture didn't account for:
>   Typesense was `expose`-only (never reachable from the browser), and the
>   backend's CSP `connect-src` was a static allowlist that never included it
>   — so chat/search failed at the network/CSP layer even with everything else
>   configured correctly. Fixed by publishing Typesense's port (matching
>   upstream) and computing `connect-src` per-request from `search.uri`'s port
>   plus the request's own host/scheme.
> - `search.enabled=true` without also setting `search.chat.model.*` left
>   `search.Client` nil (`validateConfig` fails, logged but not fatal) while the
>   migration path still saw `search.enabled=true` and indexed into the nil
>   client anyway, panicking with a raw SIGSEGV. Now skips indexing instead of
>   proceeding into the nil client.
> - `SettingsService.load()` runs inside an `APP_INITIALIZER`: an unhandled
>   rejection there blocks Angular bootstrap entirely. `GET /settings` 404s on
>   every fresh install (backend is in standby mode until an encryption key is
>   set, and doesn't register the route), which left first-run showing a
>   permanent blank page instead of the setup wizard. Now catches and defaults
>   to `{}`.
>
> Known remaining issue, not fixed here: 3 of 72 imported resources
> (ExplanationOfBenefit claims) fail to index — Typesense infers
> `resource_raw.item.adjudication.amount.value` as an integer array from the
> first document it sees, then rejects later documents with decimal values for
> that field. Pre-existing dynamic-schema limitation in how the PR indexes
> `resource_raw`, not introduced here.
>
> Added `docs/deployment/search-and-chat.md`: required `.env`, why Typesense's
> port is published and the PHI-exposure tradeoff that comes with it, the CSP
> mechanism, a model-id gotcha (`search.chat.model.id` is only created once —
> changing `model.name`/`vllm_url` later without bumping it has no effect),
> Ollama's lazy model loading (`ollama run <model>` needed before chat works,
> pulling isn't enough), a tested-better `search.chat.model.max_bytes` value
> (57344 vs the 28672 default), how to import test data, and how to verify
> search/chat actually work. Linked from `docs/deployment/README.md`'s doc
> table and configuration reference table, and from both compose files'
> Typesense comments.
>
> Verified end-to-end by tearing down the stack completely (containers,
> volumes, ./db), rebuilding from source, bringing it up with only the
> documented `.env`, signing up fresh, importing a Synthea bundle via manual
> upload, and confirming both search and chat work with zero console errors on
> a clean browser tab.
>
> ## Also included
>
> - fix(frontend): make report-medical-history-editor standalone with its own
>   imports. This dead, unreferenced, @deprecated component still failed
>   Angular's full-program type-check (missing FormsModule/CommonModule for
>   ngModel/keyvalue), breaking `docker compose build`. No behavior change;
>   found while doing a from-scratch Docker rebuild to verify this branch.
>
> Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
