# Codebase Structure

## Top-Level Layout
```
app/                    # Next.js App Router pages and API routes
  page.tsx              # Home page (classroom creation)
  layout.tsx            # Root layout
  classroom/[id]/       # Dynamic classroom page
  generation-preview/   # Generation preview UI
  api/                  # API routes (see below)
components/             # React UI components
  ui/                   # shadcn/ui base components
  roundtable/           # Roundtable discussion UI
  stage/                # Stage/presentation components
  settings/             # Settings panels
  chat/                 # Chat interface
  canvas/               # Canvas/drawing components
  slide-renderer/       # Slide rendering
  scene-renderers/      # Scene type renderers
  whiteboard/           # Whiteboard drawing
  generation/           # Generation progress UI
  agent/                # Agent avatar/display
  audio/                # Audio playback controls
  ai-elements/          # AI-generated visual elements
lib/                    # Business logic & utilities
  ai/                   # AI provider configuration
  generation/           # Lesson generation logic
  orchestration/        # Multi-agent orchestration
  playback/             # Classroom playback engine
  store/                # Zustand stores
  types/                # TypeScript type definitions
  utils/                # Utility functions
  hooks/                # React hooks
  i18n/                 # Internationalization
  export/               # PPTX/HTML export
  audio/                # Audio/TTS handling
  chat/                 # Chat logic
  pbl/                  # Project-based learning
  pdf/                  # PDF parsing
  media/                # Media handling
  server/               # Server-side utilities
  api/                  # API client utilities
  storage/              # Storage (IndexedDB via Dexie)
  contexts/             # React contexts
  prosemirror/          # ProseMirror editor config
configs/                # Static configuration (themes, fonts, shapes, etc.)
packages/               # pnpm workspace packages
  mathml2omml/          # MathML to OMML conversion
  pptxgenjs/            # PowerPoint generation
skills/openmaic/        # OpenClaw skill definition
```

## API Routes (`app/api/`)
- `generate-classroom/` - Main classroom generation endpoint
- `generate/scene-outlines-stream/` - Stream scene outlines
- `generate/agent-profiles/` - Generate AI agent profiles
- `generate/scene-content/` - Generate individual scene content
- `generate/scene-actions/` - Generate scene actions
- `generate/tts/` - Text-to-speech
- `generate/image/` - Image generation
- `generate/video/` - Video generation
- `chat/` - Chat endpoint
- `pbl/chat/` - PBL chat endpoint
- `quiz-grade/` - Quiz grading
- `parse-pdf/` - PDF parsing
- `web-search/` - Web search via Tavily
- `server-providers/` - Provider config endpoint
- `verify-model/` - Model verification
- `verify-pdf-provider/` - PDF provider verification
- `verify-image-provider/` - Image provider verification
- `verify-video-provider/` - Video provider verification
- `proxy-media/` - Media proxy
- `azure-voices/` - Azure TTS voices
- `transcription/` - Speech-to-text
- `health/` - Health check
