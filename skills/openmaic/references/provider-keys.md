# Provider Keys

## Critical Boundary

OpenMAIC generation does not automatically reuse the OpenClaw agent's current model or API key.

OpenMAIC server APIs resolve their own model and provider keys from OpenMAIC server-side config.

This skill does not rely on runtime overrides for model, provider, API key, base URL, or provider type.

If the user wants to change any of those, they must edit OpenMAIC server-side config files.

## Interaction Flow

1. Recommend one provider path first (see "Recommendation Paths" below). Do not start by asking for an API key.
2. Ask whether the user wants to configure it in `.env.local` (recommended for most users) or `server-providers.yml`.
3. Tell the user exactly which variables or YAML fields to edit — they edit the file themselves. Do not offer to write the key for them, do not ask for the literal key in chat, and do not suggest temporary request-time overrides.
4. Wait for the user to confirm they finished editing before continuing.
5. If generation later fails because of auth, provider, or model selection, direct the user back to the same server-side config files and wait for confirmation before retrying.

## Recommendation Paths

### 1. Lowest-Friction Setup

Recommended when the user wants the smallest amount of configuration.

Set:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Why:

- OpenMAIC has **no hardcoded model fallback**. If `DEFAULT_MODEL` is unset (and no client model is sent), generation **fails with an error** rather than silently picking a default. So the user must always set `DEFAULT_MODEL` explicitly to match whichever provider key they configured.
- With only `ANTHROPIC_API_KEY` set, the user must also set `DEFAULT_MODEL=anthropic:<model>` — otherwise generation cannot start.

### 2. Better Speed / Cost Balance

Recommended when the user is willing to set one extra variable.

Set:

```env
GOOGLE_API_KEY=...
DEFAULT_MODEL=google:gemini-2.5-flash
```

Why:

- Good quality-to-speed balance
- Matches the repo's current recommendation direction better than the default fallback
- The `google:` prefix is important. Without a provider prefix, model parsing defaults to OpenAI.

### 3. Existing Provider Reuse

Use when the user already has OpenAI or another supported provider configured and wants to stick with it.

Examples:

```env
OPENAI_API_KEY=sk-...
DEFAULT_MODEL=openai:gpt-5.4-mini
```

```env
DEEPSEEK_API_KEY=...
DEFAULT_MODEL=deepseek:deepseek-chat
```

## Model String Rule

When recommending or showing `DEFAULT_MODEL`, always include the provider prefix:

- `google:gemini-2.5-flash`
- `anthropic:claude-sonnet-4`
- `openai:gpt-5.4-mini`
- `deepseek:deepseek-chat`

Do not recommend bare model IDs such as `gemini-2.5-flash` by themselves, because OpenMAIC will otherwise parse them as OpenAI models.

The exact model IDs above are examples. Model names change as providers release new versions — if a recommended ID is rejected, direct the user to check the provider's official docs for the current model name and keep the `provider:` prefix.

Do not work around a wrong `DEFAULT_MODEL` by changing request parameters. The user should fix the server-side config instead.

## Preferred Config Method

For first setup, prefer `.env.local`:

```bash
cp .env.example .env.local
```

Then fill the chosen keys.

Alternative: `server-providers.yml`

```yaml
providers:
  anthropic:
    apiKey: sk-ant-...

  google:
    apiKey: ...

  openai:
    apiKey: sk-...
```

If using a non-default provider for classroom generation, also set the model selection explicitly:

```env
DEFAULT_MODEL=google:gemini-2.5-flash
```

## Recommended Prompts To The User

Example phrasing the agent can adapt:

- "I recommend configuring OpenMAIC through `.env.local` first. Please edit that file locally and tell me when you're done."
- "For the simplest setup, I recommend Anthropic. For better speed/cost balance, I recommend Google plus a `DEFAULT_MODEL` like `google:gemini-2.5-flash`. Which path do you want?"

The "do not ask for the key in chat / do not offer to write it" rules are covered in [Interaction Flow](#interaction-flow) above — do not open by requesting the key.

## Optional Features

These features require additional provider keys beyond the core LLM provider. Ask the user if they want to enable any of these after the core LLM key is configured.

| Feature | Env Variable(s) | Description |
|---------|-----------------|-------------|
| Web Search | `TAVILY_API_KEY` | Enriches outlines with real-time web research |
| Image Generation | `IMAGE_SEEDREAM_API_KEY`, `IMAGE_QWEN_IMAGE_API_KEY`, `IMAGE_NANO_BANANA_API_KEY` | Generates images for slides (any one suffices) |
| Video Generation | `VIDEO_SEEDANCE_API_KEY`, `VIDEO_KLING_API_KEY`, `VIDEO_VEO_API_KEY`, `VIDEO_SORA_API_KEY` | Generates short videos (any one suffices) |
| TTS | `TTS_OPENAI_API_KEY`, `TTS_AZURE_API_KEY`, `TTS_GLM_API_KEY`, `TTS_QWEN_API_KEY` | Text-to-speech narration (any one suffices) |

These are all optional. The classroom generation works without them — they only unlock richer content.

Alternatively, configure via `server-providers.yml`:

```yaml
web-search:
  tavily:
    apiKey: tvly-...

image:
  seedream:
    apiKey: ...

video:
  seedance:
    apiKey: ...

tts:
  openai-tts:
    apiKey: sk-...
```
