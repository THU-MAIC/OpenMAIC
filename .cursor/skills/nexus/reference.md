# Nexus — reference layout

Suggested paths (adjust if repo conventions differ):

## Track A — Homeroom

| Area | Path |
|------|------|
| Types | `lib/nexus/homeroom/types.ts` |
| Merge + adapters | `lib/nexus/homeroom/context-aggregator.ts` |
| Fixtures | `lib/nexus/homeroom/fixtures/lms/`, `calendar/`, `escalation-corpus.json` |
| Pulse prompt | `lib/nexus/homeroom/pulse-prompt.ts` |
| Orchestrator | `lib/nexus/homeroom/orchestrator.ts` |
| Escalation | `lib/nexus/homeroom/escalation-router.ts`, `escalation-actions.ts` |
| API | `app/api/nexus/pulse/route.ts`, `app/api/nexus/briefing/route.ts` |
| UI | `app/nexus/pulse/page.tsx` |
| Tests | `tests/nexus/homeroom/*.test.ts` |

## Track B — Assessment

| Area | Path |
|------|------|
| Grading types + schema | `lib/nexus/assessment/grade-types.ts`, `grade-schema.ts` |
| Grader service | `lib/nexus/assessment/mini-boss-grader.ts` |
| Labeled corpus | `lib/nexus/assessment/fixtures/grading-corpus/*.json` (100 items, human `expectedPass`) |
| Eval script | `scripts/nexus-assessment-eval.mts` or `pnpm nexus:assessment:eval` |
| Counter-Attack | `lib/nexus/assessment/counter-attack/trigger.ts`, `agent-prompt.ts` |
| Variate | `lib/nexus/assessment/variate/template.ts`, `variate.ts` |
| Skill tree | `lib/nexus/assessment/skill-tree.ts` (enum + module copy) |
| Loot Drop | `lib/nexus/assessment/loot-drop/synthesize.ts` |
| API | `app/api/nexus/assessment/grade/route.ts`, `interrogate/route.ts`, `variate/route.ts`, `report/route.ts` |
| UI (MVP 6 only) | `app/nexus/assessment/interrogate/page.tsx` (minimal) |
| Tests | `tests/nexus/assessment/*.test.ts` |

**Provider reuse**: resolve LLM via existing server utilities (`lib/server/resolve-model.ts`, `lib/ai/providers.ts`); never expose API keys to the client.

**Webhook URLs**: `process.env` placeholders only for homeroom MVP (e.g. `NEXUS_FORM_TUTOR_WEBHOOK_URL`).

---

## MVP 5 — grading correlation

- **Primary metric**: accuracy vs frozen human labels on the 100-item corpus; report **Cohen’s kappa** if class balance is skewed.
- **CI**: pin **expected metrics** on **mocked** grader responses; optional nightly/live job for real LLM drift.
- **Hallucination guardrails**: require `evidenceSpans` from submission text; fail closed (low `confidenceScore` or `pass: false`) when evidence missing.

## MVP 6 — red-team checklist (human)

Automation proves wiring and mocked judge behavior, not real-world bluff resistance. Human sessions should include:

- Paste of external “perfect” solution + vague explanation → expect **fail / further scrutiny**.
- Expert explains trade-offs tied to submitted lines → expect **pass**.
- False positive check: fast but legitimate solve → ensure trigger policy tuned (not only `time < 10s`).

## MVP 7 — expert time equivalence

Distinctness is testable in code; **time-on-task equivalence** requires timed solves by N≥3 experts × 10 variants—track outside the repo or in a linked spreadsheet.

## MVP 8 — report quality

- Skill-tree nodes are a **closed enum**; report generator must only emit registered IDs + human-readable module titles.
- Tests: forbidden generic phrases; minimum count of **concrete citations** (telemetry event types or quoted snippets).
