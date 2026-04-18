# OpenMAIC — Project Context

> **Every session — human or AI — should read `HISTORY.md` before starting work.**
> It contains the current architecture, key decisions, what has already been built, and the latest branch snapshot. Do not duplicate work that is already done.

## System Overview

- **learning.thomhoffer** = the school enrollment system — knows Lithuanian, manages daily schedule, login, streak. It tells OpenMAIC what to teach.
- **OpenMAIC** = the school itself — generates the classroom, runs the AI agents, has the LLM keys. It doesn't know about Lithuanian specifically.

The two systems communicate via API. `OPENMAIC_API_KEY` is the bearer token that `learning.thomhoffer` uses to authenticate requests to OpenMAIC endpoints (e.g. `/api/generate-classroom`, `/api/quiz-grade`).

## Session end: write Decisions & Context to PROGRESS.md

Before the session ends, write or update a `## Decisions & Context` section in `PROGRESS.md` at the repo root. Cover:
- Key decisions and why they were made (especially non-obvious choices)
- Approaches that were considered and rejected, and why
- Known tradeoffs or fragile spots in the current implementation
- Things the next session should watch out for
- What's left to do

The stop hook automatically prepends the recent commit log and commits the file. This feeds the branch-summary action with context that commit messages alone cannot convey — reasoning, rejected paths, and open questions that never make it into the repo otherwise.

