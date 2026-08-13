---
name: openmaic
description: OpenMAIC assistant for setting up, generating, and extending OpenMAIC. Use when the user wants to use OpenMAIC, generate a multi-agent interactive classroom, or build on / extend / customize OpenMAIC and its @openmaic/* SDK (secondary development, 二开) — covers Live Demo or local setup, startup modes, provider keys, classroom generation, and secondary development (forking, providers/storage/themes, routes, or the renderer/editor).
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

- If `accessCode` is present, default to Live Demo mode and skip the mode-selection prompt — unless the user's intent is to extend/build on OpenMAIC (see the exception in Phase 0).
- Use `repoDir` and `url` only as defaults for local mode.
- Still confirm before acting.

## SOP Phases

### 0. Choose Mode

First check skill config for `accessCode`. If present, announce that a stored access code was found and proceed directly to Live Demo mode (load [references/live-demo.md](references/live-demo.md), skip phases 1–4). Do not ask the user to paste the code again. **Exception:** if the user's stated intent is to extend / build on / customize OpenMAIC or consume the `@openmaic/*` SDK (二次开发 / 二开 / SDK), do not auto-shortcut — go to the extend branch below regardless of `accessCode`. A returning Live Demo user who now wants to do 二开 should be routed to extend, not silently sent back to Live Demo.

If no `accessCode` in config (or the extend exception above applies), ask the user how they want to use OpenMAIC:

1. **Use the OpenMAIC Live Demo** (recommended for quick start) — The cloud edition: the version officially deployed and hosted by the OpenMAIC team at open.maic.chat. Requires an access code (starts with `sk-`). Get yours by signing in at https://open.maic.chat, clicking your account in the top-right corner, opening "访问码设置" (access code settings), and generating a code; then add it to `~/.openclaw/openclaw.json` under `skills.entries.openmaic.config.accessCode`. No local setup needed.
2. **Run locally** — Clone the repo, configure provider keys, and run on your machine.
3. **Extend or build on OpenMAIC (二次开发)** — Fork the repo and customize the product, or consume the `@openmaic/*` SDK to build something new.

If the user chooses Live Demo mode, load [references/live-demo.md](references/live-demo.md) and skip phases 1–4.
If the user chooses local mode, proceed to phase 1 as usual.
If the user chooses to extend/build on OpenMAIC, load [references/extend.md](references/extend.md) and skip the setup/generation phases.

### 1. Clone Or Reuse Existing Repo

Load [references/clone.md](references/clone.md).

Use this when the user has not installed OpenMAIC yet or when you need to confirm which local checkout to use.

### 2. Choose Startup Mode

Load [references/startup-modes.md](references/startup-modes.md).

Use this after the repo location is confirmed. Present the available startup modes, recommend one, and wait for the user's choice.

### 3. Configure Provider Keys

Load [references/provider-keys.md](references/provider-keys.md).

Use this before starting classroom generation. Recommend a provider path and tell the user exactly which config file to edit themselves. If generation later fails due to provider/model/auth issues, return to this phase and direct the user to update the same server-side config files.

After the core LLM key is configured, ask the user if they want to enable optional features (web search, image generation, video generation, TTS). Each requires its own provider key — see the "Optional Features" section in provider-keys.md.

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
