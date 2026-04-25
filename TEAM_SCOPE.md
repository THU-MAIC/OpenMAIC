# TEAM_SCOPE.md — Maicus

## Identity

Maicus, the classroom teacher. Pair: Linus (learning.thomhoffer).

## What Maicus owns

- **Classroom generation pipeline & job runner.** Cross-device durable; confirmed via `createClassroomGenerationJob` awaited before the 202 response so the job is persisted before the client begins polling.
- **TTS provider voice selection.** Azure Speech (Cognitive Services Neural TTS). The "Maicus" voice is `lt-LT-LeonasNeural` (Lithuanian teacher); the "Linus" voice is `en-US-GuyNeural` (or learner's base-language equivalent, the explainer).
- **LLM outlines, cards, and the matching-card prompt.** All prompt authoring and tuning for outline generation and per-card generation, including matching cards.
- **Classroom storage.** Neon → Supabase Postgres DSN swap is supported; storage layer is provider-agnostic at the connection-string level.
- **Schema additions on `Stage.objective: { text, language }`.** Base-language summary of what the class teaches, populated by the outline generator.
- **Matching-card validator.** Reject or repair empty `pairs[].left` / `pairs[].right` before persisting a card to the classroom.
- **Maicus persona** embedded in the generated agent config and the scene intro action.
- **Optional Supabase Realtime channel** for streaming progress (deferred this sprint).

## What Maicus does NOT own

Linus's domain. Do not duplicate any of:

- Registration / auth / login
- Streak tracking
- Lesson queue
- Classroom UI shell (the chat-feed surface in learning.thomhoffer)
- Service worker
- Learner profile
- Easter-egg client UI

## Cross-repo contract

See `learning.thomhoffer/OPENMAIC_CONTRACT.md` for the canonical contract.

In short: Maicus accepts `requirement`, `language`, `explanationLanguage`, and an optional `learnerProfile`. Maicus returns `{ jobId, pollUrl }` immediately, then on completion returns `Classroom { stage, scenes }` with `stage.objective` populated in the learner's `explanationLanguage`.

## Gaps Maicus identified to fill this sprint

a. `Stage.objective` schema field + outline-generator population.
b. Azure Speech voice mapping (`lt-LT-LeonasNeural` → "Maicus"; base-language voice → "Linus").
c. Matching-card validator in `normalizeCards()`.
d. Maicus persona in `stage.generatedAgentConfigs`.

## Voices

lt-LT voice id alias = Maicus; base-language voice id alias = Linus. Configured via env vars `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_VOICE_MAICUS` (default `lt-LT-LeonasNeural`), and `AZURE_VOICE_LINUS` (default `en-US-GuyNeural`).

---

_Last updated: 2026-04-25. Lead-approved._
