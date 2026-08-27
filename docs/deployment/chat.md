# Chat setup

Ask a question about your own records in plain language and get an answer drawn from them
([yourphr#594](https://github.com/jwilleke/yourphr/issues/594)). The answer comes from a
language-model endpoint __you__ run. Nothing here reaches a hosted model.

__Off by default__ (`yourphr.chat.provider: null`). A stock `docker compose up -d` with no `.env`
never sends anything to a model.

## Two providers

| | `local` (recommended) | `typesense` |
|---|---|---|
| Extra service | none | a sidecar container |
| Where it searches | your records, where they already are | a second copy, in the sidecar |
| Indexing | none — a record is answerable the moment it is written | backfill, then index-on-write |
| Transcripts | the app database, encrypted at rest | the sidecar's volume, __not__ encrypted |
| Prompt changes | take effect on the next question | need a new `model.id` (see below) |
| Retrieval | full text, with the question expanded into keywords by your model | vector embeddings |

`local` is the native implementation. `typesense` is the port of the Go stack's design and survives
for anyone already running it; it is not the one to choose for a new install.

## Required `.env` values

```
YOURPHR_CHAT_PROVIDER=local
YOURPHR_CHAT_MODEL_URL=http://<host>:<port>   # your Ollama / vLLM endpoint
YOURPHR_CHAT_MODEL_NAME=<model-name>          # e.g. medgemma:27b-it-q4_K_M
```

Notes on each:

- __`YOURPHR_CHAT_MODEL_URL`__ — any OpenAI-compatible chat-completions endpoint. For Ollama use the
  bare URL, `http://<host>:11434`, with __no__ `/v1` suffix. If Ollama runs on the same machine as
  Docker Desktop, use `http://host.docker.internal:11434`.
- __`YOURPHR_CHAT_MODEL_NAME`__ — the model as your endpoint names it, with no prefix. (The `vllm/`
  prefix the `typesense` provider needs is that engine's own convention and is added internally.)
- __Load the model into memory first.__ `ollama pull` only downloads it. Ollama loads a model on its
  first inference request and unloads it after a few minutes idle, so the first question after a
  restart can time out while it loads. Run `ollama run <model-name>` once on the model host; you can
  `/bye` straight out of the prompt and it stays loaded.
- Restart `fasten` after changing any of these.

For the `typesense` provider, additionally set `YOURPHR_CHAT_PROVIDER=typesense` and
`YOURPHR_CHAT_TYPESENSE_API_KEY` (which also becomes the sidecar's own `TYPESENSE_API_KEY`, so the
two cannot drift apart).

## How retrieval works without embeddings

The sidecar embedded every record, so "what am I taking for my fits?" could reach a clonazepam
prescription that never mentions fits. Full-text search cannot do that on its own — it matches
words.

So `local` asks your model to turn the question into search terms first, then searches each term
separately and ranks a record by how many terms it matched. No extra storage, and it handles the
case above correctly.

__This means every question makes two calls to your model__: a short one to expand the question
(capped at 60 tokens) and then the one that answers it. Budget for that if the model host is shared
or slow. If the expansion call fails, the question is searched as typed rather than the answer being
abandoned — a worse search beats no answer.

Two details that cost a live failure each, both now handled:

- __Terms are searched one at a time, not together.__ The shared query builder joins words with
  `AND` — correct for a search box, where more words means "narrow it down", and fatal for an
  expanded keyword list, which would demand a record containing all eight.
- __The expansion is told the vocabulary the records use.__ Asked "what vaccinations have I had?", a
  model expanded to *"vaccination immunisation vaccine shot jab"*. The records say __Immunization__,
  American spelling, because that is what FHIR calls it. All five terms missed, and a patient with
  twelve vaccinations was told there was no information.

## How many records an answer draws on

`yourphr.chat.retrieval.max-records` (env `YOURPHR_CHAT_RETRIEVAL_MAX_RECORDS`, default `10`) caps how
many of your records one answer may be built from.

__More is not better, and the right value depends on the model you run.__ Measured against one real
Synthea record, asking "what conditions have I been diagnosed with?" where the truth is three
diagnoses:

| Records | `medgemma:4b` (q4) | `medgemma:27b-it-q4_K_M` |
|---|---|---|
| 5 | correct, clean | — |
| 10 | correct, plus one irrelevant item | correct |
| 20 | *"I am unable to answer this question"* | — |
| 25 | — | correct, and faster |
| 30 | listed __blood tests as diagnoses__ | — |

A small model degrades as context grows: it first gets noisy, then refuses, then confabulates. A
27B model improves with the extra material. Raise this only alongside a model that can use it, and
check that answers actually improve.

Both columns were measured on the `typesense` provider. The shape of the curve is a property of the
model rather than of the retrieval, so it carries over — but `local` ranks by keyword coverage
rather than vector distance, so the exact record at each depth differs, and the same 27B answering
the vaccination question returned all six vaccines under `local` against five under `typesense`.

## Context budget

`yourphr.chat.model.max-bytes` (env `YOURPHR_CHAT_MODEL_MAX_BYTES`, shipped default `57344`) caps how
much text one answer may be built from. __What exactly it caps differs by provider:__

- __`local`__ — the retrieved record text only. The system prompt and the conversation history are
  not counted against it, and are not truncated by it.
- __`typesense`__ — everything the engine assembles per turn: system prompt, retrieved records and
  history together.

A small budget truncates the medical context the model actually sees and it answers from less.
`28672` was the Go default; `57344` measured noticeably better — fewer "I don't have enough
information" answers, and answers that referenced more of the imported records. Raise it further if
your model's own context window and the host's memory allow.

Note that on `local` this is a second, independent cap alongside
`yourphr.chat.retrieval.max-records` below: whichever is reached first is what stops the context
growing.

## The create-once model (`typesense` only)

Typesense freezes the system prompt, the endpoint and `max_bytes` into a __conversation model__ when
it first creates one, and later edits do nothing to a model that already exists. So on an instance
that has already run chat, changing any `yourphr.chat.model.*` value also means bumping
`yourphr.chat.model.id` — otherwise the old settings stay in force and nothing says so.

The `local` provider has no such trap: its prompt is source, and an edit applies to the next
question.

## Indexing (`typesense` only)

The sidecar keeps its own copy of your records, so a record has to be indexed before it can be part
of an answer.

- __New and re-synced records__ are indexed as they are written.
- __Records imported before chat was switched on__ are backfilled once, in the background, the first
  time the chat page is opened. While it runs the page says so; answers improve as it finishes.
- To force a full re-index of your own records: `POST /api/secure/chat/reindex`.

The `local` provider has no index, nothing to backfill, and cannot go stale — it reads the records
where they are, so a record is answerable the moment it is written.

Neither provider lets __billing__ into an answer: `Claim`, `ExplanationOfBenefit`, `Coverage` and
friends are administrative, not clinical. `typesense` keeps them out of its index; `local`, which
has no index, filters them out of retrieval. In one Synthea bundle they were 10,917 of roughly 20,000 indexed
characters — more than half — against 193 characters for all three of the patient's diagnoses, and
they crowded real records out of every answer.

## Do not put an example date in the system prompt

Worth knowing if you ever edit the prompt. The Go implementation illustrated its date instruction
with a literal example — *"convert them into human-readable date formats (e.g.,'March 3, 2019')"*.
Asked when a medication was prescribed, a 27B model answered *"around March 3, 2019"*. The real date
was 21 May 2019. It had taken the date out of the __system prompt__ and presented it as a fact about
the patient's prescription: confident, correctly formatted, and wrong.

An illustrative date, in a prompt that is about dates, is indistinguishable to the model from a date
in the retrieved records. The shipped prompt now describes the form without supplying a value, and
tells the model never to supply a date that is not in the context.

## Security posture

This is where the TypeScript implementation deliberately departs from the Go one it replaces.

In the Go stack the __browser__ talked to Typesense directly. `GET /api/settings` was unauthenticated
and returned `search.api_key` in plaintext, compose had to publish port `8108` so the browser could
reach it, and neither the retrieval nor the conversation list carried an owner filter. Anyone who
could reach that port could read the indexed records, and on an instance with more than one account
a member's question could retrieve another member's records.

Here, for both providers:

- The browser has no search client and no key. The chat page calls `/api/secure/chat`, and the
  caller's identity comes from the session.
- Retrieval is scoped to the asking account, and only that account. `local` passes the caller to the
  Records door, which is scoped by construction; `typesense` adds `filter_by: user_id:=<caller>`,
  with the account name quoted so it cannot rewrite the clause.
- A conversation belongs to one account. Ownership is recorded in the app database
  (`chat_conversations`) and checked before any transcript is read, continued or deleted.

And for `typesense` specifically: the sidecar is __`expose`d, never published__ — only `fasten`
talks to it, at `http://typesense:8108`.

__Where the transcripts live differs, and it matters.__ Under `local` they are in the app database,
encrypted at rest with everything else. Under `typesense` the engine writes them itself, into the
`typesense-data` volume, which is __not__ encrypted. Treat that volume as holding health
information, because it does — the questions people ask about their own bodies are PHI.

## Outbound access

The SSRF guard refuses connections to internal addresses, which is what a self-hosted model endpoint
and a sidecar both are. Chat is therefore granted a __named-host exemption__ — but only for the one
host it actually connects to, which is not the same host under each provider:

- __`local`__ exempts `yourphr.chat.model.url`. It calls the model itself.
- __`typesense`__ exempts `yourphr.chat.typesense.uri`, and __not__ the model URL: this instance
  never connects to the model under that provider. The sidecar does, and it is not bound by this
  guard — which is worth knowing, because it means the model endpoint has to be reachable from the
  `typesense` container rather than from `fasten`.

Nothing else is exempted: cloud metadata, other internal hosts, and any redirect away from the named
host all stay refused. See `isAllowedHost` in `src/http/ssrf.ts`.

## Turning it off

Unset `YOURPHR_CHAT_PROVIDER` (or set it to `null`) and restart. The chat page and its nav link
disappear. On `typesense`, `docker compose up --scale typesense=0` also stops the sidecar; on
`local` there was never anything to stop. Nothing else is affected: records, sources, the dashboard
and the dashboard's own full-text search do not use any of this.
