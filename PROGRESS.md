# Branch: claude/fix-language-voice-settings-xuCgK
Updated: 2026-04-18 15:18 UTC

## Recent Commits
- 28a9c7b Fix lesson plan JSON parse failures from LLM prose wrapping
- 0052d59 chore: update PROGRESS.md [skip ci]
- 1979911 Add session-end PROGRESS.md workflow for branch-summary context
- 7dddcd8 Force cache revalidation on every deploy to fix iOS stale-app problem
- ac14912 Add AI teacher chat, on-demand TTS, and grounding image support to LessonPlanPlayer
- 55a7a49 Add dedicated LessonPlanPlayer to fix lesson_plan classroom crash
- 368e7b1 Fix crash when scenes is undefined in classroom player
- b279731 Fix throttle write path to check USE_NEON before USE_BLOB
- 8f269f6 Fix Neon driver: use .query() for parameterized SQL
- 4cae0ce Add Supabase Storage for binary files (TTS audio, images)
- a6e090e Add Neon Postgres storage for jobs and classroom JSON
- 88f907f Eliminate Vercel Blob Advanced Operations on JSON reads
- 6318077 Cut Vercel Blob ops ~60% via in-process cache + write throttle
- 070d676 Remove ja-JP/ru-RU UI locales; add BASE_LANGUAGE_NAMES
- 1315012 Enforce allowedCardKinds and cefrMode in lesson plan validator
- d58b69a Add FORKING.md — guide for re-forking upstream without losing customisations
- 9833a90 Remove Chinese (zh-CN) language support
- 9e1ebdf Fix postinstall to use pnpm workspace commands
- 9839d6c Split explanation/target language; fix iOS audio routing
- 8f0587e Fix default locale and Azure TTS voice

## Decisions & Context

### LessonPlanPlayer — AI teacher + media (session 2026-04-18)

**Why a dedicated `/api/lesson-plan-chat` route (not reusing `/api/chat`):**
The generic `/api/chat` route requires `storeState` and `agentIds` — the full slide-classroom context. Lesson plan cards don't have agents or a stage store in the same shape. A dedicated route with a `cardContext` payload keeps the system prompt simple and avoids coupling the two pipelines.

**Teacher persona is built server-side, not client-side:**
The system prompt construction lives in the route (not the component) so it can be swapped, extended, or A/B-tested without touching React. The component just sends `cardContext`.

**On-demand TTS, not pre-generated:**
Pre-generating audio for all cards at lesson-plan generation time would slow the job significantly (14+ TTS calls). On-demand fetch-on-card-display with an in-memory URL cache is fast enough and avoids storing audio blobs we may never play.

**groundingMap passed at generation time, not fetched at playback:**
learning.thomhoffer owns the vocab images. Rather than adding a `/api/grounding/:id` lookup route (which would require storing grounding data in OpenMAIC's DB), we embed the map in the persisted `LessonPlanContent` JSON. This keeps OpenMAIC stateless about Lithuanian vocabulary.

**`toTextStreamResponse` instead of `toDataStreamResponse`:**
`streamLLM` wraps the AI SDK's `streamText` and returns a `StreamTextResult`. The `toDataStreamResponse` method doesn't exist on this type — `toTextStreamResponse` does. The client reads raw text chunks, not the AI SDK data-stream protocol.

**Cache-busting approach:**
`generateBuildId` using `git rev-parse HEAD` changes all `/_next/static/[buildId]/` URLs on every deploy. Combined with `no-cache, must-revalidate` on HTML routes, this makes it impossible for iOS to serve a stale app shell that references JS chunks that no longer exist on the CDN.

**What to watch out for:**
- `currentCard` can be `undefined` if `cards` is empty. `CardDispatch` guards with `{currentCard && ...}` but `TeacherChat` receives it directly — if a lesson plan is ever generated with zero cards, the chat will receive `undefined` for `card`. Should add a guard.
- `stage.language` is passed as the TTS language — if learning.thomhoffer sends a BCP-47 tag that Azure TTS doesn't recognise, TTS will silently fail.
- The `## Decisions & Context` section in PROGRESS.md is preserved by the stop hook using `awk`. If Claude writes multiple sessions' worth of context, the file will grow. Add a date header per session (already done above) and periodically trim old sessions.

**What's next:**
- Add a guard in `LessonPlanPlayer` for empty `cards` array
- Wire `TeacherChat` to introduce the first card automatically (send an opener message on card mount) so the student isn't staring at an empty chat
- learning.thomhoffer needs to start sending `groundingMap` in the generate-classroom request to unlock vocabulary images
