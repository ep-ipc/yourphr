# /pstatus — ranked briefing & next step

A read-and-reconcile command. Run it **often** — ideally right before `/session-commit`.
It surfaces security first, ranks open work by priority, regenerates `TODO.md`, and
recommends what to do next. It does not start work.

## Scope

- `/pstatus` — the current repo (default).
- `/pstatus --all` — portfolio sweep across every active repo (P0 / security everywhere).

## Steps (single repo)

### Step 1: Gather (run in parallel, read-only)

- Security signals (quote the URL — an unquoted `?` is glob-expanded by zsh and the call silently fails with `no matches found`, which reads as a false "clean"):
  - `gh api "/repos/{owner}/{repo}/dependabot/alerts?state=open"`
  - `gh api "/repos/{owner}/{repo}/code-scanning/alerts?state=open"` (ignore a 404 — feature off)
  - `cd frontend && yarn audit --groups dependencies` — **not optional, and not covered by the two above.** Dependabot matches advisories by registry coordinates, so a dependency resolved from a **git URL** can never raise an alert. A critical one sat in the shipped bundle for months while the alerts page read `0 open` ([#530](https://github.com/jwilleke/yourphr/issues/530)). Its exit code is a bitmask of severities found (1 info, 2 low, 4 moderate, 8 high, 16 critical), not pass/fail. See [`docs/security/dependency-scanning.md`](../../docs/security/dependency-scanning.md).
  - any other scanner signal available (e.g. GitGuardian)
- `gh issue list --state open --limit 100 --json number,title,labels`
- `gh pr list --state open --limit 50 --json number,title,isDraft,mergeStateStatus,createdAt,labels,body,closingIssuesReferences`
  — `gh issue list` does **not** return PRs, so without this they are invisible to every band
  below. A merge-ready security PR can sit open across repeated `/pstatus` runs and never be
  mentioned once. `closingIssuesReferences` and `body` feed the PR ↔ issue linkage in Step 4.
- `git log --oneline -5`
- Read the last entries of `private/project_log.md` for session continuity.

### Step 2: Bridge scanner alerts → issues (idempotent)

For each open Dependabot / code-scanning / GitGuardian alert:

- Look for an existing tracking issue (search issue bodies for the marker
  `scanner-alert:<source>:<id>`).
- If none exists, create one:
  - Title: `[security] <package or rule> — <short summary>`
  - Body: the alert detail plus the marker line `scanner-alert:<source>:<id>`
  - Labels: `security` + a **graded** priority — critical/high → `P0`, medium → `P1`, low → `P2`
- Never create a duplicate for an alert that already has a tracking issue.

### Step 3: Triage gate

- Any open issue **or pull request** with **no** placement label (`P0` / `P1` / `P2` / `deferred` /
  `in-review`) gets `needs-triage` so it shows up as awaiting a decision rather than being silently
  mis-ranked. An `in-review` item is already placed (it lands in the In review band) and is never
  flagged.
- PRs are triaged on the same scale as issues, because a PR *is* work: a merge-ready security fix is
  `P0`, a routine dependency bump nobody is waiting on is `P2`, one held pending an unrelated
  upgrade is `deferred`. Apply the label with `gh pr edit <n> --add-label <band>`.

### Step 4: Rank and regenerate `TODO.md`

Regenerate the **priority-band section** of `TODO.md` from open issues/PRs. Do **not** wipe session continuity.

**Preserve the `▶ Resume here` block** when present:

1. Before writing, if `TODO.md` contains a block between `<!-- RESUME:START -->` and
   `<!-- RESUME:END -->` (inclusive), capture that exact text.
2. Write `TODO.md` in this order:
   - `# TODO`
   - the preserved resume block (if any), unchanged — do not invent or refresh its content here
   - a blank line, then `> Generated from live GitHub state — ranked by priority label.`
   - the regenerated bands below
3. If there is no resume block, omit it (bands-only is fine until `/wrap` writes one).
4. **Never** delete or rewrite the resume markers or body. Only `/wrap` updates resume content.

**Escape bare URLs taken from issue titles.** Titles are copied verbatim into `TODO.md`, so a title
containing a URL — e.g. `[FEATURE] Send to Email (https://demo.yourphr.org/web/)` — emits a bare URL
and fails markdownlint MD034, which is a red CI run for a file nobody hand-edited. Wrap any `http(s)`
URL appearing in the **title text** in angle brackets (`<https://…>`); never touch the link target of
the `[#N](…)` reference itself.

`/wrap` owns the handoff text; `/pstatus` only refreshes ranked work so multi-machine continuity
survives mid-session status runs. See [yourphr#410](https://github.com/jwilleke/yourphr/issues/410).

The bands, in this order:

- `🔴 P0 — Security & Critical` (list `security` / vulnerability issues first)
- `🟠 P1`
- `🟡 P2`
- `🔵 In review` (items labeled `in-review` — work complete and pushed, awaiting the operator's
  decision to close; takes precedence over an item's priority band so it surfaces as "ready for your call")
- `⏸ Deferred`
- `❓ Needs triage` (count + titles)

**Open PRs are not a separate band.** Every open pull request is ranked into the bands above by its
own placement label, interleaved with issues. A merge-ready security PR belongs in `P0` next to the
advisory it fixes — parking it in a trailing "Open PRs" section is exactly how finished, shippable
work goes unread. Dependency-bump PRs (Dependabot / Renovate) are ranked the same way: they are
frequently security-relevant and are easy to miss, because the corresponding scanner alert often
looks *already tracked* by an unrelated issue.

Within a band, list PRs **before** issues of the same priority — a written change is closer to done
than an unstarted one.

**One item per line — never bundle.** Each issue and each PR gets its OWN bullet, starting with a
full clickable GitHub link. No grouping headers that pack several refs onto one bullet, no
comma-separated runs, no bare `#<num>`. Issue lines:

`- [#<num>](https://github.com/{owner}/{repo}/issues/<num>) — <title>`

PR lines use the `/pull/` path, are prefixed `PR:` so they are distinguishable at a glance inside a
mixed band, carry their merge state, and **must name their related issues**:

`- PR: [#<num>](https://github.com/{owner}/{repo}/pull/<num>) — <title> _(ready | draft | conflicted | CI red)_ — closes [#<n>](…/issues/<n>)`

Mark each `draft`, `ready`, or `conflicted` from `isDraft` / `mergeStateStatus`, note failing
required checks, and flag any PR open more than 7 days as stale.

**Use `_underscore_` for the status annotation, never `*asterisk*`.** `TODO.md` is linted under
MD049 `consistent`, and the issue lines already use underscores — a single asterisk annotation
turns the whole file red in the `Lint Markdown` job of `.github/workflows/development.yaml`. This
has broken CI before. Verify with `npx markdownlint-cli2 TODO.md` before committing.

#### Resolving a PR's related issues

A PR shown without its issue context reads as unrelated housekeeping, so resolve the link for every
PR in the band. In order:

1. **Declared** — `closingIssuesReferences` from Step 1. These are the issues GitHub will
   auto-close on merge; render them as `closes #<n>`.
2. **Mentioned** — any `#<n>` in the PR body that is not a closing reference; render as `refs #<n>`.
3. **Inferred** — for a dependency-bump PR with neither, match the package name against open
   `security` issue titles and bodies (including the `scanner-alert:` markers from Step 2). A
   Dependabot PR bumping package `X` and a tracking issue for an advisory in `X` are the same work
   arriving from two directions. Render as `likely #<n>` — never as `closes`, since it is a guess.

If none of the three resolve, write `no linked issue` explicitly rather than leaving the line bare.
A silent absence is indistinguishable from "not checked".

Cross-reference both ways: an issue whose fix is already sitting in an open PR is **not** actually
open work. Annotate it in its own priority band as `— PR open: [#<pr>](…/pull/<pr>)` so the ranking
does not recommend starting something that is already written.

Where a PR turns out to be redundant — the change is already on the default branch, or a tracking
issue was resolved another way — say so on the PR line as `_(redundant — already on <branch>)_`.
Stale dependency PRs routinely outlive the fix that superseded them.

### Step 5: Brief the user

Print the ranked bands, then a single **"Do this next"** recommendation — the highest-value
P0 (else the top P1, and so on) with one line of why. Stop. Do not begin the work.

A **merge-ready PR outranks starting new work** when it carries a security fix or a dependency
bump: it is finished work sitting one click from shipping, so leaving it open while beginning
something else is strictly worse than merging it first.

State the PR ↔ issue linkage in the recommendation itself. "Merge #24 — it closes P0 #25" is
actionable; "merge #24" alone makes the operator go look up why it matters.

## `/pstatus --all` (portfolio sweep — read-only, no writes)

- Resolve the active repo list: `gh repo list <owner> --no-archived --source --limit 200 --json nameWithOwner`.
- For each repo, gather open Dependabot alerts + open issues labeled `P0` + open PRs.
- Print a cross-repo table: `repo | open P0 | open security alerts | open PRs | top item`.
- Recommend which repo needs attention first. Create no issues in sweep mode.
