# Chat setup

Ask a question about your own records in plain language and get an answer drawn from them
([yourphr#594](https://github.com/jwilleke/yourphr/issues/594)). The answer comes from a
language-model endpoint __you__ run. Nothing here reaches a hosted model.

__Off by default__ (`yourphr.chat.provider: null`). A stock `docker compose up -d` with no `.env`
never sends anything to a model.

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
- __`YOURPHR_CHAT_MODEL_NAME`__ — the model as your endpoint names it, verbatim and with no prefix.
- __Load the model into memory first.__ `ollama pull` only downloads it. Ollama loads a model on its
  first inference request and unloads it after a few minutes idle, so the first question after a
  restart can time out while it loads. Run `ollama run <model-name>` once on the model host; you can
  `/bye` straight out of the prompt and it stays loaded.
- Restart `fasten` after changing any of these.

## How retrieval works

Chat searches the same full-text index the dashboard's own search box uses, over the records where
they already are. There is no second copy of your records anywhere, and nothing to index.

Full-text search matches words, though, and a question rarely uses the record's words: "what am I
taking for my fits?" shares nothing with a clonazepam prescription. So `local` asks your model to turn the question into search terms first, then searches each term
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

Those columns were measured against an earlier, embedding-based retrieval. The shape of the curve is
a property of the model rather than of the retrieval, so it carries over — but ranking by keyword
coverage surfaces a different record at each depth, so treat the numbers as the shape of the
trade-off rather than as exact thresholds.

## Context budget

`yourphr.chat.model.max-bytes` (env `YOURPHR_CHAT_MODEL_MAX_BYTES`, shipped default `57344`) caps how
much __retrieved record text__ one answer may be built from. The system prompt and the conversation
history are not counted against it and are not truncated by it.

A small budget truncates the medical context the model actually sees and it answers from less.
`28672` was the Go default; `57344` measured noticeably better — fewer "I don't have enough
information" answers, and answers that referenced more of the imported records. Raise it further if
your model's own context window and the host's memory allow.

This is a second, independent cap alongside
`yourphr.chat.retrieval.max-records` below: whichever is reached first is what stops the context
growing.

## What chat can and cannot see

A record is answerable the moment it is written. There is no index to fill, no backfill to wait for,
and nothing that can go stale — retrieval reads the record store directly, through the same door the
rest of the app uses.

__Billing is excluded.__ `Claim`, `ExplanationOfBenefit`, `Coverage` and friends are administrative,
not clinical. In one Synthea bundle they were 10,917 of roughly 20,000 characters — more than half —
against 193 characters for all three of the patient's diagnoses, and they crowded the real records
out of every answer.

## Do not put an example date in the system prompt

Worth knowing if you ever edit the prompt. An earlier version illustrated its date instruction
with a literal example — *"convert them into human-readable date formats (e.g.,'March 3, 2019')"*.
Asked when a medication was prescribed, a 27B model answered *"around March 3, 2019"*. The real date
was 21 May 2019. It had taken the date out of the __system prompt__ and presented it as a fact about
the patient's prescription: confident, correctly formatted, and wrong.

An illustrative date, in a prompt that is about dates, is indistinguishable to the model from a date
in the retrieved records. The shipped prompt now describes the form without supplying a value, and
tells the model never to supply a date that is not in the context.

## Security posture

This is where the TypeScript implementation deliberately departs from the Go one it replaces.

In the Go stack the __browser__ talked to the search engine directly. An unauthenticated endpoint
returned that engine's API key in plaintext, compose had to publish its port so the browser could
reach it, and neither the retrieval nor the conversation list carried an owner filter. Anyone who
could reach the port could read the indexed records, and on an instance with more than one account
a member's question could retrieve another member's records.

Here:

- The browser has no search client and no key. The chat page calls `/api/secure/chat`, and the
  caller's identity comes from the session — no endpoint accepts an account name.
- Retrieval is scoped to the asking account by passing the caller to the Records door, which is
  scoped by construction.
- A conversation belongs to exactly one account. Ownership lives in the app database
  (`chat_conversations`), and both reading a transcript and writing to one filter on it __in the
  query__ rather than behind a check a future caller could forget.
- Transcripts are in the app database, encrypted at rest with everything else. The questions people
  ask about their own bodies are PHI, and an earlier design that let a sidecar keep them in its own
  unencrypted volume is exactly what this avoids.

Verified end to end with two accounts holding different patients' records: each asked about the
other's distinctive conditions and medications by name and got nothing, including under a
prompt-injection attempt naming the other patient; reading, continuing and deleting another
account's conversation are all refused.

## Outbound access

The SSRF guard refuses connections to internal addresses, which a self-hosted model endpoint is.
Chat is therefore granted a __named-host exemption__ for exactly one host: the hostname in
`yourphr.chat.model.url`. Nothing else — cloud metadata, other internal hosts, and any redirect away
from that host all stay refused. See `isAllowedHost` in `src/http/ssrf.ts`.

## Turning it off

Unset `YOURPHR_CHAT_PROVIDER` (or set it to `null`) and restart. The chat page and its nav link
disappear, and nothing reaches a model. There is no service to stop, because there never was one.
Nothing else is affected: records, sources, the dashboard and the dashboard's own full-text search
do not use any of this.
