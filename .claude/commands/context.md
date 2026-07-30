# Context Command

Read project continuity and the agent brief at the start of a session.

## Usage

Use `/context` at the start of a session to get up to speed.

### Order (required)

1. **`TODO.md` — `▶ Resume here` block** between `<!-- RESUME:START -->` and `<!-- RESUME:END -->`
   (if present). That is the last session’s handoff — branch, next steps, blockers. Do this first
   so you do not repeat finished work.
2. **`AGENTS.md`** — kit protocol (above `KIT:END`) and repo project context (below).
3. Recent `git log` and, if useful, the top of `private/project_log.md`.

### Also cover

- Project overview and goals
- Current progress and status
- Architecture and tech stack decisions
- Any blockers or issues
- Upcoming tasks and priorities

Note: `/pstatus` regenerates priority bands but **preserves** the resume block. Only `/wrap`
refreshes resume content.
