---
project_state: "active"
last_updated: "2026-08-16"
agent_priority_level: "medium"
blockers: []
requires_human_review: []
agent_autonomy_level: "high"
kit_version: "v1.10.2-0-g0903de6"
---

<!-- KIT:START v1.10.2-0-g0903de6 — managed by mjs-project-template; edit below the KIT:END marker -->
## Agent Kit Protocols

This section is __managed by the kit__ (`install-kit.sh`) — it is identical across repos. Put repo-specific context __below the `KIT:END` marker__; do not edit here.

The heading above names the kit on purpose. It used to read `Agent Context & Protocols`, which is the
same wording a repo naturally picks for its own agent section below `KIT:END` — two identical `##`
headings in one file, and `markdownlint` MD024 fails on it. The kit owns one heading string in every
repo that installs it, so that string says whose it is.

### Session continuity

- Before starting, read the `▶ Resume here` block at the top of `TODO.md` (committed, so it syncs across machines) and recent `git log`. That is where the last session left off — repeating finished work is the most common avoidable mistake.
- Commit a chunk of work with `/session-commit`: commits code + `TODO.md`, appends a journal entry to `private/project_log.md` (the log is never committed).
- Run `/pstatus` often (after every `/session-commit`): it ranks open work and recommends the next step.
- End a session with `/wrap`: commits anything outstanding, refreshes the `▶ Resume here` pointer, and reports whether it is safe to shut down the editor.

### Priorities — GitHub labels are the source of truth

Priority labels are mutually exclusive and mean:

- `P0` — __Broken. Stop all work and fix it.__ (production down / blocked / security breach)
- `P1` — __Delivers value to the mission.__
- `P2` — __Nice to have.__
- `deferred` — consciously postponed; `needs-triage` — awaiting a priority decision.

Then:

- Security comes first. Scanner alerts (Dependabot / code-scanning / GitGuardian) become issues labeled `security` + a graded priority: critical/high → `P0`, medium → `P1`, low → `P2`.
- `TODO.md` = a `▶ Resume here` block (maintained by `/wrap`) on top, then priority bands that `/pstatus` regenerates from the labels. Do not hand-edit the bands.
- The two halves have one writer each and a deliberate handover: `/wrap` writes the resume pointer at session end, `/context` reads it at session open, and the first `/pstatus` of the session __removes__ it — by then you have already resumed, so it has served its purpose. A bands-only `TODO.md` mid-session is expected, not a loss.
- Kit files are overwritten wholesale on every sync — `.claude/commands/*.md`, `utility/sync-labels.sh`, `.markdownlint-cli2.jsonc`. Never add a rule to one of them: it is destroyed at the next sync (the installer now warns, but the rule still goes). A __generic__ rule belongs upstream in [mjs-project-template](https://github.com/jwilleke/mjs-project-template) so every repo gets it. A __repo-specific__ note about a command — a package manager the kit does not name, a scanner only this repo has — goes in `.claude/commands/<command>.local.md`, which the kit never writes, reads, or deletes. Read that file, if present, as part of the command; commit it, so it travels with the repo.
- `TODO.md` holds __no history__ — only what is open right now. Never add "merged since last run", closed/merged counts, a session narrative, a dated changelog, or work from other repos. A closed item just stops appearing; that disappearance is the whole record. Session history goes in `private/project_log.md` via `/session-commit` and `/wrap`, and nowhere else.

### Working agreement

- Think before coding: state assumptions, surface trade-offs, ask when scope is ambiguous.
- Simplicity first: the minimum that solves the problem; nothing speculative.
- Use Conventional Commits for messages.
- Issue decomposition — NEVER put "Steps", "Phases", or numbered sequences inside a single GitHub issue. Break each step into its own issue and link them using GitHub relationships: `closes #N` / `fixes #N` (resolves another), `blocked by #N` (dependency), `relates to #N` (context link). Example: a 3-phase migration = 3 issues with "blocked by" chains, not one issue with Phase headings.
- Issue/PR links — Never use a bare `#N` reference alone. Always pair it with the full GitHub URL: `[#333](https://github.com/owner/repo/issues/333)`. This applies in commit messages, PR descriptions, comments, and any agent output. Use `/issues/N` for issues and `/pull/N` for PRs.
- Awaiting approval — When work is complete but requires human sign-off before closing, apply the `in-review` label and leave a comment on the issue/PR that states: what was done, what the human needs to verify, and what action closes it. Never self-close an issue or PR.
- Closing issues — __Always remove the `in-review` label when closing__ an issue or PR (`gh issue edit N --remove-label in-review` before or with the close). Closed items must not keep `in-review`, or the label stops meaning "awaiting a decision" and the queue it drives can no longer be trusted.
- Commits — always use the `/session-commit` skill. Never run a bare `git commit` directly. `/session-commit` enforces the session log update, conventional commit format, and co-author trailer.
- Direct commits by default — commit to the default branch; do not open a pull request unless someone other than you will actually look at it before it lands. On a single-maintainer repo a self-opened, self-merged PR reviews nothing: it just splits one explanation across a commit message and a near-identical PR body. Put the reasoning in the commit message. A change touching a "risky" path, closing an issue, or feeling significant is __not__ a reason to open one — CI runs on `push` as well as `pull_request`, so a direct commit is still tested. Where a PR does exist, its body points at the commit message rather than restating it.

### Markdown conventions

__Read `.markdownlint-cli2.jsonc` before writing markdown.__ It is the control file — rules, globs
and ignores in one place, read by the editor, the CLI, CI and you, and identical in every repo the
kit installs into. Do not rely on a summary: this section deliberately does not restate the rules,
because a second copy drifts from the first the moment someone changes one.

Most markdown here is written by agents, so these are writing rules, not review rules — conform on
the first draft rather than relying on `--fix`. There is no exemption mechanism and none is wanted;
a disabled check is a check nobody revisits. Verify with `npm run lint:md`, or `npx markdownlint-cli2`
where there is no `package.json`.

Only committed files are linted: anything `.gitignore`d is generated or vendored, so its source is
linted instead.
<!-- KIT:END -->

## yourphr-ts-spike

### Project Context

A spike, not a product. It exists to answer one question for [jwilleke/yourphr](https://github.com/jwilleke/yourphr): can a TypeScript/Node FHIR store replace the Go backend? The decision and its stop rule live in that repo — `docs/planning/strategy-typescript-transition.md` ([#539](https://github.com/jwilleke/yourphr/issues/539)), and the architecture this code follows is `docs/planning/architecture-principles-typescript.md`.

Nothing here ships to a user. Prefer proving something and writing down the number over building something that works.

### Two hard rules

__Real patient records live in `./phi` and must never enter git history.__ A leak is irreversible and a privacy breach. `.gitignore` is not the control — `git add -f` walks past it — so `scripts/check-no-phi.sh` runs as a pre-commit hook and in CI. Never commit `.db`, `.ndjson`, anything under `phi/`, or a file carrying FHIR patient fields. Never use `git add -A` here without looking at what it staged.

__All outbound network access goes through `src/http`.__ That is where the SSRF guard lives, and it is worth exactly nothing if another file can import `node:https` or call `fetch()` directly — Node's built-in fetch is undici, which ignores `http.Agent` and therefore ignores the guarded DNS lookup that is the actual control. `scripts/check-http-boundary.sh` fails the build when anything else opens a path to the network.

### Commands

| Command | What it does | Needs real records |
|---|---|---|
| `npm run typecheck` | types | no |
| `npm run ssrf` | SSRF guard suite, 47 checks | no |
| `npm run check:boundary` | network access confined to `src/http` | no |
| `npm run check:phi` | no patient data in tracked files | no |
| `npm run load -- --in <ndjson> --db <db>` | load a corpus through `SqliteFhirRepository` | yes |
| `npm run diff` / `writes` / `isolation` / `http` | the comparison harnesses | yes |

Only the first four run in CI, because CI must never see PHI. The rest run on the operator's machine.

### What is proven so far

Measured against a real 19,796-resource export, not fixtures: generic indexing in 551 lines against 18,518 generated Go lines; 0 identity collisions across 8 sources; 71/71 queries matching Medplum's reference repository; 29/29 resource types matching production id for id; 11/11 on the write path; 6/6 on per-user isolation; 9/9 on the frontend HTTP contract.

__Sync is the untested one__, and it is the phase the whole decision turns on.

### Conventions

A guard nobody has tried to defeat is not known to work. Every check here was verified by breaking the thing it protects and confirming it goes red — do the same for anything new.
