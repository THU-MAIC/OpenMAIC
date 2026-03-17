---
name: openmaic
description: Guided SOP for setting up and using OpenMAIC from OpenClaw. Use when the user wants to clone the OpenMAIC repo, choose a startup mode, configure recommended API keys, start the service, or generate a classroom from requirements or a PDF. Run one phase at a time and ask for confirmation before each state-changing step.
user-invocable: true
metadata: { "openclaw": { "emoji": "🏫" } }
---

# OpenMAIC Skill

Use this as a guided, confirmation-heavy SOP. Do not compress the whole setup into one reply and do not perform state-changing actions without explicit user confirmation.

## Core Rules

- Move one phase at a time.
- Before any state-changing action, ask for confirmation.
- If local state already exists, show what you found and ask whether to keep it.
- Do not assume the OpenClaw agent's own model or API key will be reused by OpenMAIC.
- OpenMAIC classroom generation uses OpenMAIC server-side provider config.
- This skill must not rely on any request-time model or provider overrides.
- Only OpenMAIC server-side config files may control provider selection and defaults.
- Do not default to asking the user to paste API keys into chat.
- Prefer guiding the user to edit local config files themselves.
- Do not offer to write API keys into config files on the user's behalf.
- Once setup is complete and the user clearly asks to generate a classroom, do not ask for a second confirmation before submitting the generation job.
- Keep confirmations for local file reads such as reading a PDF from disk.

## Optional Skill Config

If present, read defaults from `~/.openclaw/openclaw.json` under:

```jsonc
{
  "skills": {
    "entries": {
      "openmaic": {
        "enabled": true,
        "config": {
          "accessCode": "sk-xxx",
          "repoDir": "/path/to/OpenMAIC",
          "url": "http://localhost:3000"
        }
      }
    }
  }
}
```

- If `accessCode` is present, default to hosted mode and skip the mode-selection prompt.
- Use `repoDir` and `url` only as defaults for local mode.
- Still confirm before acting.

## SOP Phases

### 0. Choose Mode

First check skill config for `accessCode`. If present, announce that a stored access code was found and proceed directly to hosted mode (load [references/hosted-mode.md](references/hosted-mode.md), skip phases 1–4). Do not ask the user to paste the code again.

If no `accessCode` in config, ask the user how they want to use OpenMAIC:

1. **Use hosted OpenMAIC** (recommended for quick start) — Requires an access code from open.maic.chat. No local setup needed.
2. **Run locally** — Clone the repo, configure provider keys, and run on your machine.

If the user chooses hosted mode, load [references/hosted-mode.md](references/hosted-mode.md) and skip phases 1–4.
If the user chooses local mode, proceed to phase 1 as usual.

### 1. Clone Or Reuse Existing Repo

Load [references/clone.md](references/clone.md).

Use this when the user has not installed OpenMAIC yet or when you need to confirm which local checkout to use.

### 2. Choose Startup Mode

Load [references/startup-modes.md](references/startup-modes.md).

Use this after the repo location is confirmed. Present the available startup modes, recommend one, and wait for the user's choice.

### 3. Configure Provider Keys

Load [references/provider-keys.md](references/provider-keys.md).

Use this before starting classroom generation. Recommend a provider path and tell the user exactly which config file to edit themselves. If generation later fails due to provider/model/auth issues, return to this phase and direct the user to update the same server-side config files.

### 4. Start And Verify OpenMAIC

After the user has chosen a startup mode and configured keys, start OpenMAIC using the chosen method, then verify the service with `GET {url}/api/health`.

### 5. Generate A Classroom

Load [references/generate-flow.md](references/generate-flow.md).

Use this only after the service is healthy. Confirm before reading local PDFs. If the user has already clearly asked to generate, do not ask for a second confirmation before submitting the generation job, and then follow the polling loop until it succeeds or fails. Only send the supported content fields for generation requests. For long-running jobs, prefer sparse polling and tell the user to check back later if the turn ends before completion.

## Response Style

- Keep each step short and explicit.
- Prefer 2-3 concrete options when the user must choose.
- Always include the recommended option first and explain why in one sentence.
- After a step completes, say what changed and what the next confirmation is for.
- When returning a classroom link, place the raw absolute URL on its own line with no bold, markdown link syntax, code formatting, or tables.
