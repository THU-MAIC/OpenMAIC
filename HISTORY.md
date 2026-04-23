# OpenMAIC — Shared Development History

## System Overview

**OpenMAIC** is an AI-powered classroom server. It generates interactive multi-agent lessons (slides, quizzes, TTS audio, images, video) from a short text requirement. It knows nothing about specific subjects — it is a general teaching engine.

**learning.thomhoffer** is the school enrollment system. It knows the student (Lithuanian language learning, streak, schedule) and calls OpenMAIC's API to generate each class. Authentication uses `OPENMAIC_API_KEY` as a bearer token.

```
learning.thomhoffer  →  POST /api/generate-classroom  →  OpenMAIC
                        { requirement, language: 'lt-LT',
                          explanationLanguage: 'en-US',
                          enableTTS: true }
```

---

## Architecture

### Generation Pipeline

1. **Stage 1 — Outlines**: LLM produces `SceneOutline[]` from the requirement. Titles, descriptions, keyPoints are written in `explanationLanguage` (en-US). Lithuanian vocabulary words appear inline.
2. **Stage 2 — Content**: Each outline generates a slide (`PPTElement[]`), quiz (`QuizQuestion[]`), or interactive (`html`).
3. **Stage 3 — Actions**: Each scene gets speech/spotlight actions. Speech text is in `language` (lt-LT) — only the Lithuanian words to pronounce.
4. **Stage 4 — Media & TTS**: Images/video generated async; TTS audio pre-rendered per action using Azure `lt-LT-OnaNeural`.

Job results stored in Vercel Blob. Client polls `/api/generate-classroom/:jobId`.

### Key Design Decisions

- **Dual language**: `language` (target, spoken) vs `explanationLanguage` (display, UI). When they differ, slide text is in `explanationLanguage`, TTS speaks only `language` words.
- **Provider fallback**: If the configured LLM is overloaded or has no key, `resolveModel` walks a fallback chain (Gemini 2.5 Flash → Gemini 2.0 Flash → GPT-4o-mini).
- **Blob storage**: All classroom data and job progress stored in Vercel Blob (private). Media proxied through `/api/classroom-media/:id/`.
- **TTS voice resolution**: `resolveTTSVoice()` in `classroom-media-generation.ts` maps BCP-47 codes to Azure Neural voices (`lt-LT → lt-LT-OnaNeural`, `en-US → en-US-JennyNeural`).

---

## API Surface (for learning.thomhoffer)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/generate-classroom` | Bearer `OPENMAIC_API_KEY` | Start classroom generation job |
| `GET /api/generate-classroom/:jobId` | Bearer | Poll job status / get result |
| `GET /api/health` | — | Healthcheck, returns model config |

### Generate-classroom request body
```json
{
  "requirement": "Lithuanian pronunciation: hook consonants š č ž",
  "language": "lt-LT",
  "explanationLanguage": "en-US",
  "enableTTS": true,
  "enableImageGeneration": false,
  "enableVideoGeneration": false
}
```

---

## What Has Been Done

### Session 2026-04-17

**Language & voice fixes:**
- Default UI locale: `zh-CN` → `en-US` (`lib/i18n/types.ts`)
- Default Azure TTS voice: `zh-CN-XiaoxiaoNeural` → `lt-LT-OnaNeural` (`lib/audio/constants.ts`)

**Dual-language generation pipeline:**
- Added `explanationLanguage` field to `UserRequirements`, `SceneOutline`, `GenerateClassroomInput`
- Prompt templates updated: outlines/slide text in `explanationLanguage`, speech actions in `language`
- Agent personas generated in `explanationLanguage`
- API route passes `explanationLanguage` through from request body

**iOS audio fix:**
- Added `audio.setAttribute('playsinline', '')` to all `new Audio()` calls in `audio-player.ts`, `use-tts-preview.ts`, `use-discussion-tts.ts`
- Fixes audio routing through ringer channel instead of media channel on iPhone

**Vercel deployment fix:**
- `postinstall` switched from `npm run build` to `pnpm --filter` for workspace packages
- `npm` couldn't resolve pnpm-hoisted binaries (rollup) in pnpm v10, causing silent stall

### Earlier (branch claude/class-generation-error-handling-0Bbyv)

- Added Vercel Blob storage for classrooms and job data
- Lesson plan scene type (`lesson_plan`) for language learning
- Model fallback chain with "high demand" / overload detection
- BCP-47 language code support (any language, not just zh-CN/en-US)
- Chinese removed from UI language toggle; EN and LT only
- Fetch retry for Safari "Load failed" resilience
- Azure TTS and media generation routed through blob storage
- TTS voice resolution by content language in server generation

### Earlier (initial integration)
- CORS support for cross-origin API calls from learning.thomhoffer
- `OPENMAIC_API_KEY` bearer auth on generate-classroom endpoints
- Language-aware TTS integration

---

## Environment Variables

Critical variables for the learning.thomhoffer use case:

```
OPENMAIC_API_KEY          # Bearer token learning.thomhoffer uses to call this API
DEFAULT_MODEL             # e.g. google:gemini-2.5-flash
GOOGLE_GENERATIVE_AI_API_KEY
AZURE_TTS_KEY
AZURE_TTS_REGION
BLOB_READ_WRITE_TOKEN     # Vercel Blob
```

See `.env.example` for the full list.

---

## File Map (key files)

```
app/
  api/
    generate-classroom/         # Job-based classroom generation (external API)
    generate/                   # Scene-level generation (client streaming)
    health/                     # Status + model info
  classroom/[id]/               # Classroom playback UI
  page.tsx                      # Home: generation input

lib/
  server/
    classroom-generation.ts     # Main generation orchestrator
    classroom-media-generation.ts  # TTS + image generation; resolveTTSVoice()
    classroom-storage.ts        # Blob read/write
    resolve-model.ts            # Provider + model selection with fallback
    api-auth.ts                 # Bearer token validation
  generation/
    outline-generator.ts        # Stage 1: outlines
    scene-generator.ts          # Stage 2–3: content + actions
    prompts/templates/          # LLM prompt markdown files
  types/
    generation.ts               # UserRequirements, SceneOutline
    stage.ts                    # Stage, Scene, Action
  audio/
    constants.ts                # DEFAULT_TTS_VOICES (azure: lt-LT-OnaNeural)
  i18n/
    types.ts                    # defaultLocale = 'en-US'

packages/
  mathml2omml/                  # Vendored: MathML → OOXML converter
  pptxgenjs/                    # Vendored: PPTX generation library
```

---

### Branch snapshot — 2026-04-17 08:16 UTC

**3 commit(s) in the last 12 hours:**

  - claude/fix-language-voice-settings-xuCgK (1 new commit)

```
9e1ebdf Fix postinstall to use pnpm workspace commands
9839d6c Split explanation/target language; fix iOS audio routing
8f0587e Fix default locale and Azure TTS voice
```

---

### Branch snapshot — 2026-04-23 20:08 UTC

**4 commit(s) in the last 12 hours:**

  - claude/investigate-database-setup-TIHlw (1 new commit)

```
d4f9057 Fix useTTS hook and fill-blank crash in lesson-plan-player
ef14e8f Normalize turn.text → turn.lithuanian and clarify field name in prompt
a5f5e89 Drop stale localStorage locale if no longer in supportedLocales
504c89a Require pronunciation on all LithuanianWord fields and A1/A2 dialog turns
```
