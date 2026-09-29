# Provider Keys

## Critical Boundary

OpenMAIC generation does not automatically reuse the OpenClaw agent's current model or API key.

OpenMAIC resolves every model and key on the server, from its own model configuration:

- `openmaic.yml` (written by the operator; path overridable with `OPENMAIC_CONFIG`) declares providers and assigns models to capability slots. Keys stay in `.env.local` and are referenced from the file as `${VAR}`.
- The model settings in the OpenMAIC web app (**Settings → Models**) edit the slots and providers `openmaic.yml` leaves open, for the current workspace.

This skill does not rely on runtime overrides for model, provider, API key, base URL, or provider type. The old request headers (`x-model`, `x-api-key`, `x-base-url`, `x-model-routes`, `x-*-provider`, …) are deprecated and ignored once a slot is configured; never use them as a workaround.

If the user wants to change the model or provider, they edit `openmaic.yml` (and `.env.local` for the key) or use the model settings in the web app.

## Interaction Flow

1. Recommend one provider path first (see "Recommendation Paths" below). Do not start by asking for an API key.
2. Ask whether the user wants to configure it in `openmaic.yml` + `.env.local` (recommended for self-hosting and anything reproducible) or in the web app's model settings after starting (simplest for a personal install).
3. Tell the user exactly which file and fields to edit — they edit the files themselves. Do not offer to write the key for them, do not ask for the literal key in chat, and do not suggest temporary request-time overrides.
4. Wait for the user to confirm they finished editing before continuing. `openmaic.yml` is read at startup: a running server must be restarted after it changes.
5. If startup or generation later fails because of auth, provider, or model selection, direct the user back to the same configuration and wait for confirmation before retrying.

## The Configuration File

Start from the example in the repository:

```bash
cp .env.example .env.local
cp openmaic.example.yml openmaic.yml
```

Three concepts:

- **Provider** — an account the server can call: an id the user chooses, a `preset` (which vendor), and `apiKey: ${VAR}`.
- **Slot** — a use of AI. `llm` is the default chat model for everything; `course.outline`, `course.content`, `course.content.slide`, `classroom`, `agent`, … override it for one use; `tts`, `asr`, `image`, `video`, `webSearch` and `document` are the media and tool capabilities.
- **Assignment** — `slot: <provider id>:<model id>`, or `<provider id>` alone for search/document/media providers (their default model), or `null` to turn the capability off.

Minimal file:

```yaml
providers:
  anthropic:
    preset: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

slots:
  llm: anthropic:claude-sonnet-4-6
```

with `ANTHROPIC_API_KEY=sk-ant-...` in `.env.local`.

Slots written in `openmaic.yml` are locked for the web UI; slots left out follow their parent (`llm` for chat slots) and can be changed in the model settings.

## Recommendation Paths

### 1. One Key for Everything (token plan)

Recommended when the user wants illustrations, narration, video and web search with the least setup. A token plan preset covers several capabilities with one key:

```yaml
providers:
  minimax:
    preset: minimax
    apiKey: ${MINIMAX_API_KEY}

slots:
  llm: minimax:MiniMax-M3
  image: minimax
  video: minimax
  tts: minimax
  webSearch: minimax
```

Other token plan presets: `tokendance`, `volcengine-ark`, `kimi-coding-plan` (chat only).

### 2. A Single Chat Vendor

Recommended when the user already has a key for one vendor:

```yaml
providers:
  google:
    preset: google
    apiKey: ${GOOGLE_API_KEY}

slots:
  llm: google:gemini-2.5-flash
```

Same shape for `openai` (`OPENAI_API_KEY`), `anthropic`, `deepseek`, `qwen`, `glm`, `kimi`, `openrouter` and the other chat presets.

### 3. Web App Only

For a personal install where the user does not want to edit files: start OpenMAIC, open **Settings → Models**, and connect a service there. The key is entered in the browser, stored encrypted on the server, and never shown again. Nothing to edit in `openmaic.yml`.

### 4. Existing Environment-Variable Setups

A deployment configured through provider variables (`OPENAI_API_KEY`, …), `server-providers.yml`, `DEFAULT_MODEL` and `MODEL_FALLBACK` still works while there is no `openmaic.yml`; the server translates it at startup and logs a deprecation notice. Recommend moving to `openmaic.yml` when the user touches the configuration anyway. `MODEL_ROUTES` is no longer read: a server that sets it without `openmaic.yml` refuses to start, and the per-stage models must be written as slots (see the Configuration docs, "Migrating from the legacy configuration").

## Model Reference Rule

In `openmaic.yml`, a chat slot always names `<provider id>:<model id>`, where the provider id is the key under `providers` (not necessarily the preset):

- `google:gemini-2.5-flash`
- `anthropic:claude-sonnet-4-6`
- `openai:gpt-5.4-mini`
- `deepseek:deepseek-v4-flash`

A chat slot with a provider id alone (`llm: openai`) is refused at startup. Non-chat slots may use the provider id alone.

The exact model IDs above are examples. Model names change as providers release new versions — if a model ID is rejected by the provider, direct the user to the provider's official docs (or the Supported models page) for the current name.

## Optional Features

These features need their own slot assigned, usually with a provider of their own. Ask the user if they want any of them after the chat model works. Each provider is declared once under `providers` and assigned to its slot.

| Feature | Slot | Example presets |
|---------|------|-----------------|
| Web Search | `webSearch` | `tavily`, `exa`, `bocha`, `brave`, `baidu` |
| Image Generation | `image` | `seedream`, `qwen-image`, `nano-banana`, `openai-image` |
| Video Generation | `video` | `seedance`, `kling`, `veo`, `minimax-video` |
| TTS | `tts` | `openai-tts`, `azure-tts`, `glm-tts`, `qwen-tts`, `minimax-tts` |
| Speech Recognition | `asr` | `openai-whisper`, `qwen-asr`, `funasr-asr` |
| Document Parsing | `document` | `mineru-cloud`, `mineru`, `alidocmind` |

Example:

```yaml
providers:
  tavily:
    preset: tavily
    apiKey: ${TAVILY_API_KEY}
  seedream:
    preset: seedream
    apiKey: ${IMAGE_SEEDREAM_API_KEY}

slots:
  webSearch: tavily
  image: seedream
```

These are all optional. Classroom generation works without them — they only unlock richer content. To turn one off explicitly, set its slot to `null`.

## Recognizing Configuration Errors

- **Server exits at startup with `Invalid model configuration in …/openmaic.yml`** — the message lists each problem with its path (an unset `${VAR}`, an unknown preset or slot, a provider not declared under `providers`, a chat slot without a model id). Relay it to the user unchanged.
- **`MODEL_ROUTES does not carry over to the model configuration …`** — the user must write the per-stage models as slots in `openmaic.yml` and remove `MODEL_ROUTES`.
- **`No model is configured for <slot>`** — assign that slot (or its parent, e.g. `llm`) in `openmaic.yml` or the model settings.
- **`The <slot> capability is turned off`** — the slot is `null`; the operator turned it off on purpose.

## Recommended Prompts To The User

Example phrasing the agent can adapt:

- "I recommend configuring OpenMAIC with `openmaic.yml`: copy `openmaic.example.yml`, keep your key in `.env.local`, and tell me when you're done."
- "For the least setup, one token plan key covers chat, images, narration, video and search. If you already have an Anthropic or Google key, a single `llm` line is enough. Which path do you want?"

The "do not ask for the key in chat / do not offer to write it" rules are covered in [Interaction Flow](#interaction-flow) above — do not open by requesting the key.
