# Chat setup

Ask a question about your own records in plain language and get an answer drawn from them
([yourphr#594](https://github.com/jwilleke/yourphr/issues/594)). Retrieval is a
[Typesense](https://typesense.org) sidecar; the answer comes from a language-model endpoint __you__
run. Nothing here reaches a hosted model.

__Off by default__ (`yourphr.chat.provider: null`). A stock `docker compose up -d` with no `.env`
never starts a model request and never touches the sidecar.

## Required `.env` values

```
YOURPHR_CHAT_PROVIDER=typesense
YOURPHR_CHAT_TYPESENSE_API_KEY=<generate: openssl rand -hex 16>
YOURPHR_CHAT_MODEL_NAME=vllm/<model-name>        # e.g. vllm/llama3.1:8b, vllm/medgemma:4b
YOURPHR_CHAT_MODEL_VLLM_URL=http://<host>:<port> # your Ollama / vLLM endpoint
```

Notes on each:

- __`YOURPHR_CHAT_TYPESENSE_API_KEY`__ — also becomes the sidecar's own `TYPESENSE_API_KEY`
  (`docker-compose.yml` reads the same variable), so the two cannot drift apart. Unlike the earlier
  Go implementation, this key never reaches a browser.
- __`YOURPHR_CHAT_MODEL_NAME`__ — __must__ start with `vllm/`. That prefix is what tells Typesense to
  call your `vllm_url` instead of OpenAI's hosted API; the part after the slash is passed through as
  the model name your endpoint understands (an Ollama tag, a vLLM served model name). The app
  __refuses to start__ without the prefix rather than let records leave the building.
- __`YOURPHR_CHAT_MODEL_VLLM_URL`__ — any OpenAI/vLLM-compatible chat-completions endpoint. For
  Ollama use the bare URL, `http://<host>:11434`, with __no__ `/v1` suffix. If Ollama runs on the
  same machine as Docker Desktop, use `http://host.docker.internal:11434`; on another host, its
  address — reachable from wherever the `typesense` container runs, which is what makes the call.
- __Load the model into memory first.__ `ollama pull` only downloads it. Ollama loads a model on its
  first inference request and unloads it after a few minutes idle, so the first question after a
  restart can time out while it loads. Run `ollama run <model-name>` once on the model host
  (matching the part after `vllm/`); you can `/bye` straight out of the prompt and it stays loaded.
- Restart `fasten` after changing any of these.

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
27B model improves with the extra material and answers more completely — the same question about
vaccinations returned five vaccines with both dose dates at 25 records, against a truncated list at
10. Raise this only alongside a model that can use it, and check that answers actually improve.

## Context window

`yourphr.chat.model.max-bytes` (env `YOURPHR_CHAT_MODEL_MAX_BYTES`, shipped default `57344`) caps how
much context Typesense assembles per turn: system prompt, retrieved records, and conversation
history. A small budget truncates the medical context the model actually sees and it answers from
less. `28672` was the Go default; `57344` measured noticeably better — fewer "I don't have enough
information" answers, and answers that referenced more of the imported records. Raise it further if
your model's own context window and the host's memory allow.

## The create-once model, and the gotcha it carries

Typesense freezes the system prompt, the endpoint and `max_bytes` into a __conversation model__ when
it first creates one, and later edits do nothing to a model that already exists. So on an instance
that has already run chat, changing any `yourphr.chat.model.*` value also means bumping
`yourphr.chat.model.id` — otherwise the old settings stay in force and nothing says so.

## Indexing

Chat answers from an index of your records, not from the records directly, so a record has to be
indexed before it can be part of an answer.

- __New and re-synced records__ are indexed as they are written.
- __Records imported before chat was switched on__ are backfilled once, in the background, the first
  time the chat page is opened. While it runs the page says so; answers improve as it finishes.
- To force a full re-index of your own records: `POST /api/secure/chat/reindex`.

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

Here:

- The sidecar is __`expose`d, never published__. Only `fasten` talks to it, at
  `http://typesense:8108`.
- The API key stays in the server process. No endpoint returns it, and the browser has no Typesense
  client at all — the chat page calls `/api/secure/chat`.
- Every retrieval carries `filter_by: user_id:=<caller>`, taken from the session, and the account
  name is quoted so it cannot rewrite the filter.
- Transcripts live in the sidecar, which has no field for an owner, so ownership is recorded in the
  app database (`chat_conversations`) and checked before any transcript is read, continued or
  deleted. That table holds an account name, a conversation id and a timestamp — deliberately not
  the message text, which is PHI.

One consequence worth stating plainly: the __questions and answers themselves are stored in
Typesense__, in the volume `typesense-data`, and that volume is not encrypted at rest the way the
records database is. Treat it as holding health information, because it does.

## Outbound access

The SSRF guard refuses connections to internal addresses, which is what a sidecar is. Chat is
therefore granted a __named-host exemption__ for the single hostname in
`yourphr.chat.typesense.uri`, and nothing else — cloud metadata, other internal hosts, and any
redirect away from that host all stay refused. See `isAllowedHost` in `src/http/ssrf.ts`.

## Turning it off

Unset `YOURPHR_CHAT_PROVIDER` (or set it to `null`) and restart. The chat page and its nav link
disappear, and `docker compose up --scale typesense=0` stops the sidecar. Nothing else is affected:
records, sources, the dashboard and the dashboard's own full-text search do not use any of this.
