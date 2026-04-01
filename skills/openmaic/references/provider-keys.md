# Provider Keys

## Critical Boundary

OpenMAIC generation does not automatically reuse the OpenClaw agent's current model or API key.

OpenMAIC server APIs resolve their own model and provider keys from OpenMAIC server-side config.

This skill does not rely on runtime overrides for model, provider, API key, base URL, or provider type.

If the user wants to change any of those, they must edit OpenMAIC server-side config files.

## Interaction Policy

- Do not begin by asking the user to paste an API key into chat.
- First, recommend a provider path.
- Then ask how the user wants to configure it.
- The user should edit `.env.local` or `server-providers.yml` themselves.
- Do not offer to write the key for them.
- Do not ask for the literal key in chat.
- Do not suggest temporary request-time overrides.
- If generation fails because of auth, provider, or model selection, direct the user back to server-side config files.

## Preferred User Flow

1. Recommend a provider option.
2. Ask where the user wants to configure it:
   - `.env.local` (recommended for most users)
   - `server-providers.yml`
3. Tell the user exactly which variables or YAML fields to edit.
4. Wait for the user to confirm they finished editing before continuing.

## Recommendation Paths

### 1. Lowest-Friction Setup

Recommended when the user wants the smallest amount of configuration.

Set:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Why:

- OpenMAIC server fallback is currently `gpt-4o-mini` if `DEFAULT_MODEL` is unset.
- If the user wants Anthropic or Google by default, they should set `DEFAULT_MODEL` explicitly.

### 2. Better Speed / Cost Balance

Recommended when the user is willing to set one extra variable.

Set:

```env
GOOGLE_API_KEY=...
DEFAULT_MODEL=google:gemini-3-flash-preview
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
DEFAULT_MODEL=openai:gpt-4o-mini
```

```env
DEEPSEEK_API_KEY=...
DEFAULT_MODEL=deepseek:deepseek-chat
```

## Model String Rule

When recommending or showing `DEFAULT_MODEL`, always include the provider prefix:

- `google:gemini-3-flash-preview`
- `anthropic:claude-3-5-haiku-20241022`
- `openai:gpt-4o-mini`
- `deepseek:deepseek-chat`

Do not recommend bare model IDs such as `gemini-3-flash-preview` by themselves, because OpenMAIC will otherwise parse them as OpenAI models.

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
DEFAULT_MODEL=google:gemini-3-flash-preview
```

## Recommended Prompts To The User

Preferred:

- "I recommend configuring OpenMAIC through `.env.local` first. Please edit that file locally and tell me when you're done."
- "For the simplest setup, I recommend Anthropic. For better speed/cost balance, I recommend Google plus `DEFAULT_MODEL=google:gemini-3-flash-preview`. Which path do you want?"

Avoid as the first move:

- "Send me your API key"
- "Paste your API key here"
- "Do you want me to write the key for you?"

## Confirmation Requirements

- Recommend one provider path first.
- Ask the user which config-file path they want.
- Instruct the user to modify the file themselves.
- Wait for the user to confirm they finished editing before continuing.
- Do not request the literal key.
- If provider/model/auth errors happen later, tell the user exactly which config entry to fix and wait for confirmation before retrying.

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
