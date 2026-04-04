---
name: nexus
description: >-
  Implements Nexus in OpenMAIC: homeroom MVPs 1–4 (StudentContext, pulse, briefing, escalation)
  and assessment MVPs 5–8 (Mini-Boss grading API, Counter-Attack interrogator, Variate scenario
  engine, Loot Drop diagnostic reports). Use when the user mentions Nexus, homeroom, grading API,
  Counter-Attack, variate scenarios, skill-tree report, Stage 2–4 assessment, or MVP 1–8.
---

# Nexus

Two tracks share **`lib/nexus/`**, **Vitest**, and **`app/api/nexus/`**; keep subfolders separate (`homeroom/` vs `assessment/`). Do not entangle with classroom lesson generation unless reusing server LLM resolution only.

## Track A — Homeroom (MVP 1–4)

Pastoral / daily loop (see sections below).

## Track B — Assessment (MVP 5–8)

Technical evaluation pipeline: **Stage 2** isolated grading (MVP 5), **Stage 3** anti-cheat + synthesis (MVP 6–7), **Stage 4** diagnostics (MVP 8). **API-first** for MVP 5; chat UI only where MVP 6 requires it.

---

# Track A — Homeroom

## Non-negotiables

- **No biometric data** in any schema or mock.
- **PII separation**: processing types use **`studentId` (UUID)** only—no names or emails in `StudentContext` / `SessionState` used for logic.
- **Pulse is ephemeral**: morning-loop state lives in memory / client session; **no persistent chat logs** to DB.
- **Escalation**: **Tier 3** must never rely on LLM alone—**deterministic regex/keyword path** must fire first and **cannot be down-ranked** by the model.

## MVP 1 — Context Aggregator

1. Types + validation: `StudentContext` (LMS + calendar fields, `dataQuality` / gaps for missing data).
2. Adapters: `parseLmsMock`, `parseCalendarMock` — **never throw** on partial JSON; default empty structures.
3. `buildStudentContext({ studentId, lms, calendar })` — single merge function.
4. Fixtures: at least **three** edge cases—late-night submission, packed calendar, sparse/missing fields.
5. **DoD**: Vitest loads all three; merge completes **without throws**; output validates to schema.

## MVP 2 — 10-Second Pulse

1. `SessionState` includes **`cognitiveLoad`**: `High` | `Med` | `Low`, plus greeting metadata, timestamps.
2. **POST** `app/api/nexus/pulse/route.ts`: input = `StudentContext` + raw text/emoji; server-only LLM via existing server provider patterns.
3. Structured model output (e.g. `generateObject`) for enum fields—not free-text parsing for load level.
4. Minimal UI e.g. `app/nexus/pulse/page.tsx`: submit → show greeting + load; **wipe state** on loop completion.
5. **DoD**: five distinct `StudentContext` profiles; tests use **mocked LLM** for CI stability; optional live integration behind env flag.

## MVP 3 — Orchestrator

1. Pure function `orchestrateDay(session, context)` → **Markdown briefing** (exactly **three** bullets) + **`FocusModeActive: boolean`**.
2. **Rule**: `cognitiveLoad === 'High'` ⇒ **`FocusModeActive === true`**; briefing **reduces** / **prioritizes** to prevent overwhelm.
3. Bullets must be **atomic** (single concrete action, e.g. “Draft history intro paragraph”).
4. **DoD**: Vitest table-driven—High load always sets Focus mode true; list behavior matches spec.

## MVP 4 — Tiered Escalation Router

1. **`ThreatTier`**: `1` | `2` | `3` with documented semantics.
2. **`tier3KeywordRouter(text)`** — regex/keyword list for explicit crisis/self-harm; runs **before** LLM; match ⇒ Tier 3 **always**.
3. LLM (optional) for lower tiers—**max** with deterministic tier or skip LLM when Tier 3 locked.
4. **`executeEscalation(tier)`**: Tier 1 = local log; Tier 2 = mock Form Tutor webhook; Tier 3 = mock crisis path + log; **no real PII in logs**.
5. Integrate router on **every** student text in the pulse flow.
6. **DoD**: corpus of **50** strings in fixtures; Vitest asserts **100% Tier 3** on all **keyword-defined** Tier-3 cases and webhook behavior (mocked). Do **not** claim 100% accuracy on sarcasm vs distress for the full set unless explicitly labeled and human-reviewed.

## Implementation order (Track A)

Build **MVP 1** and **MVP 4** (pure + tests) early; ship **MVP 2** only after keyword escalation is wired; then **MVP 3**.

---

# Track B — Assessment

### Shared assessment non-negotiables

- **Anonymized candidate IDs** in APIs and logs (UUID); no names in grading payloads.
- **Anti-hallucination for MVP 5**: model output must be **structured** (schema); include **`rubricVersion`** and **`evidenceSpans`** (quotes or line refs from the submission) where feasible; optional **deterministic checks** (parse JSON, run formatter) as input to the grader, not as a silent replacement for the rubric.
- **Counter-Attack (MVP 6)** must **ground questions in the actual submission** (AST diff, highlighted snippet, or rubric dimension)—no generic trivia.

## MVP 5 — Mini-Boss Evaluation Engine

1. **POST** `app/api/nexus/assessment/grade/route.ts` (or `evaluate`): body = `{ taskPrompt, candidateSolution, rubricId? }`.
2. Measure **`executionTimeMs`** server-side (wall clock for the grade request).
3. Response JSON: **`pass`** (boolean), **`executionTimeMs`**, **`confidenceScore`** (0–1), plus **`rubricVersion`**, **`reasoning`** (short, for audit only; do not expose to candidate if product forbids).
4. **Fixture corpus**: **100** labeled submissions (50 pass, 50 fail)—stored as JSON files with **human label** and optional **expert notes**.
5. **DoD**: Offline eval script computes **agreement with human labels** (accuracy / Cohen’s kappa); target **≥ 95%** on this fixed corpus. Run **regression** in CI against frozen fixtures with **mocked LLM** or recorded outputs; live-model gate in optional job. Document failure modes (hallucinated pass) in test names.

## MVP 6 — Counter-Attack Interrogator

1. **Trigger model**: deterministic rules from telemetry—e.g. `timeToSolveSeconds < 10` OR **`perfectionFlag`** from static analysis / complexity heuristic (define explicitly in code).
2. **Agent**: specialized system prompt + tool-less or minimal-tool chat; **one primary follow-up** per trigger, referencing submission artifact.
3. **Session store**: in-memory or short TTL for MVP; log **decision** only if policy allows (no full transcript retention unless required).
4. **DoD**: **Red-team script**—fixtures for “pasted perfect + vacuous explanation” vs “expert natural explanation”; Vitest asserts **expected disposition** when using **mocked judge LLM**; human red-team checklist in `reference.md` for what automation cannot prove.

## MVP 7 — Variate Engine

1. **Input**: master scenario template (prompt + bug spec + schema + constraints) as structured data—not prose only.
2. **`variate(scenarioSeed, template)`** → new scenario: renamed symbols, shifted bug location, perturbed dataset rows, **equivalent difficulty** by construction (same algorithmic family / same rubric dimensions).
3. **Output**: serialized scenario for candidate + **internal answer-key metadata** (for graders only, never sent to client).
4. **DoD**: **10** variations from one template; **`pnpm`** script checks structural distinctness (hash surfaces); **expert time study** documented externally (skill cannot claim “same time” without measured data—track in spreadsheet + link from repo doc if needed).

## MVP 8 — Loot Drop Synthesizer

1. **Input**: Final Boss telemetry (events, edits, test runs) + Counter-Attack transcript (if any).
2. **Output**: **Markdown** report mapping each failure to **skill-tree node IDs** (predefined enum), e.g. `SKILL.RESOURCE_MEMORY` → “Module 3: Resource Management”.
3. Prompt/schema constraints: **no generic praise**; every paragraph must cite a **specific observed behavior** (event ID, quote, or rubric miss).
4. **DoD**: Vitest **snapshot** or structured checks: report contains **≥ N** skill-tree references for fixture sessions; **forbidden phrase list** test (e.g. “great job”, “keep it up”) optional.

## Implementation order (Track B)

**MVP 7** (deterministic variate) before or parallel with **MVP 5** so grades target stable rubrics. **MVP 5** before **MVP 6** (need graded artifact to interrogate). **MVP 8** last (consumes telemetry + interrogation).

## Verification

Run `pnpm test` under `tests/nexus/` (split `homeroom/` vs `assessment/`). Do not claim work is complete without passing tests.

## Optional deep reference

For paths, evaluation metrics, and red-team checklist, see [reference.md](reference.md).
