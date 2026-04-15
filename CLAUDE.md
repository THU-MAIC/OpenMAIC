# OpenMAIC — Project Context

## System Overview

- **learning.thomhoffer** = the school enrollment system — knows Lithuanian, manages daily schedule, login, streak. It tells OpenMAIC what to teach.
- **OpenMAIC** = the school itself — generates the classroom, runs the AI agents, has the LLM keys. It doesn't know about Lithuanian specifically.

The two systems communicate via API. `OPENMAIC_API_KEY` is the bearer token that `learning.thomhoffer` uses to authenticate requests to OpenMAIC endpoints (e.g. `/api/generate-classroom`, `/api/quiz-grade`).
