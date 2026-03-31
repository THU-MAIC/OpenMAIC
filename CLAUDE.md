# OpenMAIC — Project Intelligence

**Goal**: Build interactive AI-powered classrooms for Uzbek audiences.

## Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript 5
- **AI/LLM**: Vercel AI SDK (`@ai-sdk`) — OpenAI, Anthropic, Google, DeepSeek, Grok, etc.
- **Orchestration**: LangGraph (`@langchain/langgraph`) — StateGraph director/agent pattern
- **Styling**: Tailwind CSS 4, shadcn/ui, Radix UI
- **State**: Zustand (localStorage) + IndexedDB (media/audio via Dexie)
- **Slides**: Custom PPTist renderer (in-house canvas editor)
- **Audio**: Multi-provider TTS/ASR (OpenAI, Azure/edge-tts, ElevenLabs, Qwen, GLM, browser)
- **Export**: Custom `pptxgenjs` fork (PPTX), self-contained HTML
- **Package manager**: `pnpm` (workspaces — `packages/pptxgenjs`, `packages/mathml2omml`)

## How to Run

```bash
# Dev
pnpm install && pnpm dev        # http://localhost:3232

# Production (standalone)
pnpm build
node .next/standalone/server.js   # NOT pnpm start — standalone mode
# After every build, copy env + static files:
cp .env.local .next/standalone/.env.local
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

# Tunnel (for remote access — build first, HMR doesn't work through tunnels)
cloudflared tunnel --url http://localhost:3232
```

Config: copy `.env.local` (already configured for Doston's setup).

## Current Config (Doston's Setup)

- **Port**: 3232 (dev and prod)
- **LLM**: Google Gemini — `GOOGLE_API_KEY` + `DEFAULT_MODEL=google:gemini-2.5-flash`
- **Ollama**: Also configured at `http://localhost:11434/v1` (OPENAI_BASE_URL)
- **TTS (Chinese/English)**: Kokoro at `http://localhost:8880/v1` (openai-tts provider)
- **TTS (Uzbek)**: edge-tts at `http://localhost:8881` (azure-tts provider)
- **Image generation**: SDXL-Turbo at `http://localhost:8765` (local-image provider)
- **Location**: `~/Desktop/OpenMAIC`

### Starting Local Services

```bash
# Start SDXL-Turbo (8765) + edge-tts (8881) together + opens TTS test UI
~/.local/share/openmaic-images/start-services.sh

# Or individually:
~/.local/share/openmaic-images/start.sh          # SDXL-Turbo only
cd ~/.local/share/openmaic-images && source venv/bin/activate && python3 tts-server.py  # edge-tts only

# Kokoro TTS (port 8880) — separate setup, start independently
# TTS test UI: ~/.local/share/openmaic-images/tts-test.html
# Logs: ~/.local/share/openmaic-images/logs/
```

## Architecture

### Generation Pipeline (Two Stages)

```
User Prompt + PDF
       ↓
Stage 1: outline-generator.ts
       → LLM generates SceneOutline[] (5–15 scenes)
       → Each has: type, title, keyPoints, mediaRequests
       ↓
Stage 2: scene-generator.ts (per outline)
       → Generate content (slides/quiz/interactive/PBL)
       → Generate actions (speech, whiteboard, spotlight...)
       → Generate TTS audio
       → Generate images/video (optional)
       ↓
Persist classroom → return ID + URL
```

**Entry point**: `lib/server/classroom-generation.ts`
**API**: `POST /api/generate-classroom` → returns `jobId` → poll `GET /api/generate-classroom/[jobId]`

### Two Generation Paths

| Path | How triggered | TTS | Stored |
|------|--------------|-----|--------|
| **Client-side** (interactive) | Browser generation-preview page | Client calls `/api/generate/tts` | IndexedDB + server (`POST /api/classroom`) |
| **Server-side** (batch) | `POST /api/generate-classroom` | Server generates + writes audio files | `data/classrooms/[id].json` |

**Important**: Client-side generation now also persists to `data/classrooms/` via a `POST /api/classroom` call at the end of `app/generation-preview/page.tsx`.

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
| `stage.ts` | current classroom scenes + mode | IndexedDB (Dexie) |
| `media-generation.ts` | image/video job tracking | IndexedDB |

### API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/generate-classroom` | Submit async server-side generation job |
| `GET /api/generate-classroom/[jobId]` | Poll job status/result |
| `POST /api/classroom` | Persist a classroom (stage+scenes) to server filesystem |
| `GET /api/classroom/[id]` | Load a persisted classroom |
| `POST /api/regenerate-tts/[classroomId]` | Re-run TTS for existing classroom with language override |
| `POST /api/chat` | SSE multi-agent discussion |
| `POST /api/parse-pdf` | Extract text+images from PDF |
| `POST /api/quiz-grade` | LLM-grade quiz answer |
| `POST /api/transcription` | ASR audio transcription |
| `POST /api/web-search` | Tavily search |
| `GET /api/server-providers` | List server-configured providers |
| `GET /api/health` | Health check |
| `POST /api/auth/register` | Create new user account (public) |
| `POST /api/auth/change-password` | Change own password (authenticated) |
| `GET /api/admin/users` | List all users (admin only) |
| `PATCH /api/admin/users` | Change a user's role (admin only) |
| `DELETE /api/admin/users` | Delete a user (admin only, not self) |

## Configuration

### Environment Variables (`.env.local`)

```env
# LLM
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
GOOGLE_API_KEY=...
GOOGLE_MODELS=gemini-2.5-flash
DEFAULT_MODEL=google:gemini-2.5-flash

# TTS
TTS_OPENAI_API_KEY=kokoro
TTS_OPENAI_BASE_URL=http://localhost:8880/v1
TTS_AZURE_API_KEY=edge-tts
TTS_AZURE_BASE_URL=http://localhost:8881

# Image generation
IMAGE_LOCAL_IMAGE_API_KEY=local
IMAGE_LOCAL_IMAGE_BASE_URL=http://localhost:8765

PORT=3232
```

### `server-providers.yml` (alternative/override to env vars)

**Load order**: YAML > env vars > client overrides

## Uzbek Support

### Language Selectors (two separate controls)
- **Top-right dropdown** — UI locale (interface language: 中文 / English / O'zbekcha)
- **Toolbar pill** — Course content language (cycles: 中文 → EN → UZ → 中文)

### TTS Language Routing
- **Uzbek course** (`language=uz`) → automatically uses `azure-tts` + `uz-UZ-MadinaNeural` voice
- **Chinese/English** → uses `openai-tts` (Kokoro) with configured voice
- This applies to both server-side batch generation AND client-side interactive generation
- Implemented in:
  - Server: `lib/server/classroom-media-generation.ts` `generateTTSForClassroom()`
  - Client: `lib/hooks/use-scene-generator.ts` `generateAndStoreTTS()` + `generateTTSForScene()`

### Regenerating TTS for Existing Classrooms
```bash
# Re-run TTS with Uzbek voice for a specific classroom
curl -X POST http://localhost:3232/api/regenerate-tts/[classroomId] \
  -H 'Content-Type: application/json' \
  -d '{"language":"uz"}'
# classroomId from URL: /classroom/[classroomId]
```

### edge-tts Notes
- Free, no API key, uses Microsoft Edge voice backend
- Voices: `uz-UZ-MadinaNeural` (female), `uz-UZ-SardorNeural` (male)
- Server file: `~/.local/share/openmaic-images/tts-server.py`
- Rate format must be `+0%` not `0%` — edge-tts throws `ValueError: Invalid rate '0%'`
- Fixed in both `tts-server.py` (SSML parser) and `lib/audio/tts-providers.ts` (`generateAzureTTS`)

## Auth & User Management

### User Model
- `id`, `email`, `name?`, `password` (bcrypt), `role` (`teacher` | `admin`), `createdAt`
- Default role on registration: `teacher`
- First admin must be created manually via Prisma/SQLite (no bootstrap UI)

### Pages
| Path | Access | Purpose |
|------|--------|---------|
| `/login` | Public | Sign in with email + password |
| `/register` | Public | Self-registration (creates teacher account) |
| `/dashboard/settings` | Any user | Change own password |
| `/dashboard/users` | Admin only | View/change roles/delete users |

### Role access in components
- `session.user.role` is available client-side via `useSession()` and server-side via `auth()`
- `components/user-menu.tsx` shows "Users" link only when `role === 'admin'`
- `/dashboard/users` page client-redirects to `/dashboard` if not admin
- `/api/admin/users` returns 403 if not admin

### i18n
- All auth keys live under `auth.*` in `lib/i18n/settings.ts` (all 3 locales: zh-CN, en-US, uz)

## Important Gotchas

1. **Port is 3232** — dev and prod both use 3232. Tunnel: `cloudflared tunnel --url http://localhost:3232`

2. **Standalone server ignores project `.env.local`** — `process.chdir(__dirname)` moves CWD to `.next/standalone/`. After every `pnpm build`, copy: `cp .env.local .next/standalone/.env.local`. Otherwise TTS/image generation silently fail.

3. **Static files after build** — must copy: `cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public`

4. **SSRF guard** — `lib/server/ssrf-guard.ts` blocks localhost URLs from clients in production. Fixed by checking server-configured URL first: if provider has a server-configured baseUrl, skip SSRF check entirely. Applied to: `/api/generate/image`, `/api/generate/tts`, `/api/verify-image-provider`.

5. **`DEFAULT_MODEL` + `GOOGLE_MODELS=gemini-2.5-flash`** — forces Gemini auto-select on fresh browsers so users don't need to configure anything via tunnel.

6. **Model selection persists to localStorage** — `autoConfigApplied` flag prevents re-running auto-select. Clear localStorage to reset.

7. **`pnpm start` warns about standalone** — use `node .next/standalone/server.js` instead.

8. **PDF text limit**: `MAX_PDF_CONTENT_CHARS = 20000`. Long PDFs get truncated.

9. **Dev mode + tunnels** — HMR doesn't work through tunnels. Always build production before exposing. Requires `allowedDevOrigins: ['*.trycloudflare.com']` in `next.config.ts`.

10. **Duplicate env keys in `.env.local`** — template has empty fallback entries below configured values. Remove the empty duplicates or they override your values (e.g. empty `TTS_AZURE_API_KEY=` overrides `TTS_AZURE_API_KEY=edge-tts`).

11. **Client-side classrooms now also server-persisted** — `app/generation-preview/page.tsx` POSTs to `/api/classroom` after generation. Old classrooms made before this change are IndexedDB-only.

12. **SDXL-Turbo image server** — `~/.local/share/openmaic-images/start.sh`. ~6GB VRAM. Provider ID: `local-image`. API key: `local`. Model caches to `~/.cache/huggingface` (~6.5GB, downloads on first run).

13. **azure-tts rate format** — edge-tts requires `+0%` not `0%`. Fixed in both TS adapter and Python server.

14. **NextAuth v5 middleware cookie mismatch** — never use `getToken` from `next-auth/jwt` in middleware. It looks for `next-auth.session-token` (v4 name) but v5 uses `authjs.session-token` / `__Secure-authjs.session-token` (HTTPS). Result: session always null on tunnel → infinite login redirect. Fix: split config into `auth.config.ts` (edge-safe, no DB imports) and use `NextAuth(authConfig).auth` in middleware.

15. **`lib/server/db.ts` used `process.cwd()` for DB path** — standalone server CWD is `.next/standalone/`, so it created a separate DB there, ignoring `DATABASE_URL`. Fixed: `db.ts` and `prisma/seed.ts` now check `process.env.DATABASE_URL` first. `.env.local` has `DATABASE_URL` set to the absolute project path so both dev and standalone use the same DB.

## Key Files to Know

```
lib/generation/outline-generator.ts       — Stage 1: requirements → outlines
lib/generation/scene-generator.ts         — Stage 2: outlines → full scenes
lib/orchestration/director-graph.ts       — Multi-agent LangGraph state machine
lib/action/engine.ts                      — Action execution (speech, whiteboard, etc.)
lib/server/classroom-generation.ts        — Server-side end-to-end pipeline
lib/server/classroom-media-generation.ts  — Server-side TTS + image/video generation
lib/server/classroom-storage.ts           — Read/write data/classrooms/*.json
lib/server/provider-config.ts             — Env/YAML provider config loader
lib/hooks/use-scene-generator.ts          — Client-side generation hook (TTS language routing here)
lib/audio/tts-providers.ts               — TTS provider adapters (azure rate fix here)
lib/store/settings.ts                     — All client config (huge — 49KB)
app/generation-preview/page.tsx           — Client-side generation UI + server persist call
app/api/generate-classroom/route.ts       — Async server generation job API
app/api/regenerate-tts/[classroomId]/     — Re-run TTS with language override
app/classroom/[id]/                       — Classroom playback page
~/.local/share/openmaic-images/server.py      — SDXL-Turbo FastAPI server
~/.local/share/openmaic-images/tts-server.py  — edge-tts FastAPI server (Uzbek TTS)
```
