# OpenMAIC — Project Intelligence

**Goal**: Build interactive AI-powered classrooms for Uzbek audiences.

## Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript 5
- **AI/LLM**: Vercel AI SDK (`@ai-sdk`) — OpenAI, Anthropic, Google, DeepSeek, Grok, etc.
- **Orchestration**: LangGraph (`@langchain/langgraph`) — StateGraph director/agent pattern
- **Styling**: Tailwind CSS 4, shadcn/ui, Radix UI
- **State**: Zustand (localStorage) + IndexedDB (media)
- **Slides**: Custom PPTist renderer (in-house canvas editor)
- **Audio**: Multi-provider TTS/ASR (OpenAI, Azure, ElevenLabs, Qwen, GLM, browser)
- **Export**: Custom `pptxgenjs` fork (PPTX), self-contained HTML
- **Package manager**: `pnpm` (workspaces — `packages/pptxgenjs`, `packages/mathml2omml`)

## How to Run

```bash
# Dev
pnpm install && pnpm dev        # http://localhost:3000

# Production
pnpm build && pnpm start

# Docker
docker compose up --build

# Tunnel (for remote access)
cloudflared tunnel --url http://localhost:3000
```

Config: copy `.env.example` → `.env.local`, add at least one LLM API key.

## Current Config (Doston's Setup)

- **LLM**: Google Gemini via `GOOGLE_API_KEY` in `.env.local`
- **Default model**: `google:gemini-2.5-flash`
- **TTS**: Browser native (robotic) — needs OpenAI key for quality TTS
- **Location**: `~/Desktop/OpenMAIC`

## Architecture

### Generation Pipeline (Two Stages)

```
User Prompt + PDF
       ↓
Stage 1: outline-generator.ts
       → LLM generates SceneOutline[] (5–15 scenes)
       → Each has: type, title, keyPoints, mediaRequests
       ↓
Stage 2: scene-generator.ts (parallel per outline)
       → Generate content (slides/quiz/interactive/PBL)
       → Generate actions (speech, whiteboard, spotlight...)
       → Generate TTS audio (parallel)
       → Generate images/video (parallel, optional)
       ↓
Persist classroom → return ID + URL
```

**Entry point**: `lib/server/classroom-generation.ts`
**API**: `POST /api/generate-classroom` → returns `jobId` → poll `GET /api/generate-classroom/[jobId]`

### Scene Types

| Type | What it is | Export |
|------|-----------|--------|
| `slide` | PPT slides with agent narration | PPTX |
| `quiz` | Questions (single/multi/short answer), LLM-graded | — |
| `interactive` | Self-contained HTML/JS simulation | HTML |
| `pbl` | Project-Based Learning workspace with MCP agent tools | — |

### Multi-Agent Orchestration

**LangGraph StateGraph**: `director` → `agent_generate` → `director` (loop)

- **Director**: LLM or code decides which agent speaks next
- **Agents**: teacher, student, assistant, domain_expert — each with persona + role
- **Routing rules**: role diversity (no same role twice), content dedup, language enforcement
- **Max turns**: configurable (default 6)

**Key files**:
- `lib/orchestration/director-graph.ts` — StateGraph definition
- `lib/orchestration/director-prompt.ts` — Director routing logic
- `lib/orchestration/registry/` — Agent config store

### Action System (28+ types)

Agents produce ordered JSON action arrays executed by `lib/action/engine.ts`:
- `speech` — TTS narration
- `spotlight` — highlight slide element
- `laser` — laser pointer on slide
- `wb_draw_text/shape/chart/latex/table/line` — whiteboard drawing
- `discussion` — trigger live agent discussion
- `wb_open/close` — whiteboard toggle

**Critical**: Whiteboard and slide canvas are mutually exclusive. When whiteboard is open, spotlight/laser don't work.

### State Management

| Store | Key State | Persistence |
|-------|-----------|-------------|
| `settings.ts` (49KB) | provider config, TTS/ASR, agents, playback speed | localStorage |
| `canvas.ts` | current slide being edited + history | localStorage |
| `stage.ts` | current classroom scenes + mode | localStorage |
| `media-generation.ts` | image/video job tracking | IndexedDB |

### API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/generate-classroom` | Submit async generation job |
| `GET /api/generate-classroom/[jobId]` | Poll job status/result |
| `POST /api/chat` | SSE multi-agent discussion |
| `POST /api/parse-pdf` | Extract text+images from PDF |
| `POST /api/quiz-grade` | LLM-grade quiz answer |
| `POST /api/transcription` | ASR audio transcription |
| `POST /api/web-search` | Tavily search |
| `GET /api/server-providers` | List server-configured providers |
| `GET /api/health` | Health check |

## Configuration

### Environment Variables (`.env.local`)

```env
# LLM (at least one required)
GOOGLE_API_KEY=...          # Gemini — recommended for this setup
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...

# Default server-side model
DEFAULT_MODEL=google:gemini-2.5-flash

# TTS (optional — browser-native used if missing)
TTS_OPENAI_API_KEY=...      # Best quality TTS option

# Web search (optional)
TAVILY_API_KEY=...
```

### `server-providers.yml` (alternative to env vars)

```yaml
providers:
  google:
    apiKey: ...
tts:
  openai-tts:
    apiKey: ...
```

**Load order**: YAML > env vars > client overrides

## Important Gotchas

1. **Model selection persists to localStorage** — first visit on a new device will always prompt for model selection. This is client-side UX, not a server issue.

2. **`pnpm start` warns about standalone** — `"next start" does not work with "output: standalone"`. Works anyway but the correct command for production is `node .next/standalone/server.js`.

3. **PDF text limit**: `MAX_PDF_CONTENT_CHARS = 20000`. Long PDFs get truncated.

4. **Vision images limit**: First 5 images sent to LLM, rest described as text.

5. **TTS is server-side** — audio URLs generated during classroom creation. No client-side fallback if TTS down.

6. **Language enforcement is critical** — all agents must respond in the course language. Mixing languages breaks TTS (English TTS reading Arabic text).

7. **Dev mode + tunnels = pain** — HMR (hot reload) doesn't work through tunnels. Always build production (`pnpm build`) before exposing via tunnel. Also requires `allowedDevOrigins: ['*.trycloudflare.com']` in `next.config.ts`.

8. **Gemini has no TTS** — Gemini is LLM only. For quality voice: OpenAI TTS (`TTS_OPENAI_API_KEY`).

9. **Classroom URLs are permanent** — classrooms persist on the server. Same URL works after restart (stored in server memory/IndexedDB). No regeneration needed to change TTS provider.

10. **`DEFAULT_MODEL` format**: `provider:model-id` — e.g., `google:gemini-2.5-flash`, `anthropic:claude-3-5-haiku-20241022`.

11. **Standalone server ignores project `.env.local`** — `process.chdir(__dirname)` moves CWD to `.next/standalone/`. After every `pnpm build`, copy env: `cp .env.local .next/standalone/.env.local`. Otherwise TTS, image generation, etc. silently stop working.

12. **Local image server (SDXL-Turbo)** — runs at `http://localhost:8765`. Start with `~/.local/share/openmaic-images/start.sh`. Model downloads to `~/.cache/huggingface` (~6.5GB) on first run. Uses ~6GB VRAM. Provider ID: `local-image`. API key: `local`.

## For Uzbek Audience

When prompting for Uzbek content:
- Set language to `uz` or specify in prompt: "All explanations in Uzbek"
- The agent language enforcement will apply — all agents speak Uzbek
- TTS: OpenAI TTS supports Uzbek (use `nova` or `alloy` voice)
- ASR: OpenAI Whisper supports Uzbek
- Consider: `agentMode: 'auto'` generates culturally-appropriate agent personas
- Prompt tip: "Generate for Uzbek beginners, use familiar Uzbek examples and analogies"

## Key Files to Know

```
lib/generation/outline-generator.ts   — Stage 1: requirements → outlines
lib/generation/scene-generator.ts     — Stage 2: outlines → full scenes
lib/orchestration/director-graph.ts   — Multi-agent LangGraph state machine
lib/action/engine.ts                  — Action execution (speech, whiteboard, etc.)
lib/server/classroom-generation.ts    — End-to-end pipeline
lib/store/settings.ts                 — All client config (huge — 49KB)
app/api/generate-classroom/route.ts   — Async generation job API
app/classroom/[id]/                   — Classroom playback page
```
