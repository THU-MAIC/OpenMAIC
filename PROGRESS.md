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
