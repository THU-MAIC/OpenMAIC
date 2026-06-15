# AGENTS.md — OpenMAIC Research-First Covenant

This repository follows a **research-first** methodology. No non-trivial architectural decision, feature, or dependency is implemented until it has been researched, documented, and reviewed via an Architecture Decision Record (ADR).

---

## 1. The Research-First Loop

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Problem   │────▶│  Research   │────▶│    ADR      │────▶│    Code     │
│  / Hypothesis│     │  (BFS/DFS)  │     │  + Citations │     │  + Tests    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

### Rules

1. **Research before architecture.** If a change affects architecture, algorithms, dependencies, deployment, data privacy, or business model, run research first.
2. **Document before code.** Every significant decision is recorded in `docs/adrs/ADR-###-*.md` with numbered citations.
3. **Use parallel research agents.** Delegate independent research topics to `explore` subagents and synthesize findings.
4. **10-persona filter.** Before finalizing an ADR, mentally (or explicitly) run the proposal through the 10 expert personas in §4.
5. **Prefer minimal changes.** Choose the simplest research-backed option that satisfies the requirement.

---

## 2. Research Method: BFS / DFS / Bidirectional

For each significant question, decide which research pattern fits:

| Pattern | Use when | Output |
|---------|----------|--------|
| **BFS (breadth-first)** | Mapping a landscape: competitors, standards, data sources, stakeholders. | Comparison table + gap analysis. |
| **DFS (depth-first)** | Deep technology or algorithm investigation: OMR, IRT, model choice. | Recommended option + failure modes + MVP architecture. |
| **Bidirectional** | Cross-domain impact: business model ↔ technology, pedagogy ↔ engineering. | Trade-off matrix + go-to-market implications. |

A typical feature needs **at least one BFS and one DFS** before an ADR.

---

## 3. Citations

All factual claims in ADRs and research reports must cite sources with stable URLs or canonical references. Use this format:

- `[T#]` — theoretical / pedagogical / algorithmic sources.
- `[R#]` — reference implementations, open-source projects, SDK docs.
- `[G#]` — go-to-market, pricing, stakeholder sources.
- `[S#]` — standards, curriculum, regulatory sources.

Citations are collected in a **References** section at the end of each document. Do not cite without evidence.

---

## 4. The 10-Persona Filter

Before approving an ADR, ensure the proposal has been considered from these perspectives:

1. **Principal / Teacher** — Will this reduce workload and improve outcomes?
2. **Student** — Is the experience respectful, clear, and not demotivating?
3. **Parent** — Do I get visibility without being spammed?
4. **Tuition-center Owner** — Does this drive enrollment or results cheaply?
5. **Privacy Officer** — Is PII handled correctly (FERPA/GDPR)?
6. **Site Reliability Engineer** — Can this run reliably on low-cost infra?
7. **ML Engineer** — Is the algorithm measurable, debuggable, and calibratable?
8. **Curriculum Expert** — Is content aligned to board/syllabus standards?
9. **Open-Source Maintainer** — Is the change minimal, tested, and documented?
10. **Business Strategist** — Does this advance the beachhead and defensibility?

Not every ADR needs a full written review from each, but the author should explicitly note any persona whose concerns are not yet addressed.

---

## 5. ADR Template

Create new ADRs at `docs/adrs/ADR-###-short-title.md` using this structure:

```markdown
# ADR-### — Title

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-###  
**Date:** YYYY-MM-DD  
**Author:**  
**Related:**

## Context

## Decision

## Consequences

### Positive

### Negative / Trade-offs

## Alternatives Considered

## Implementation Sketch (optional)

## Metrics for Success (optional)

## References
```

Use sequential numbers. If an existing ADR is superseded, update its status and link forward.

---

## 6. Existing Decisions

| ADR / Decision | Topic | Status |
|----------------|-------|--------|
| `docs/decisions/DECISION-20260614-001-pdf-rendering.md` | Server-side PDF rendering with Playwright | Accepted |
| `docs/decisions/DECISION-20260615-002-pdf-observability-concurrency.md` | PDF concurrency limiter + structured logging | Accepted |
| `docs/adrs/ADR-001-adaptive-engine-with-omr-loop.md` | Adaptive worksheet engine + OMR scan loop | Proposed |
| `docs/research/research-report-001-dr-math-adaptive-engine.md` | Research synthesis for Dr. Math | Proposed |

---

## 7. How to Run Research Agents

From this repo, use the `explore` subagent type for read-only research:

```text
Agent(subagent_type="explore", prompt="...")
```

Guidelines:

- Launch **3–5 agents in parallel** for independent questions.
- Give each agent a single research topic, explicit questions, and a word limit.
- Ask agents to return **structured findings + citations/URLs**.
- Synthesize conflicting findings in the research report; do not hide uncertainty.

---

## 8. Communication Style

- Be concise; prefer bullet tables over long prose.
- Use the same language as the user.
- Make minimal changes; do not over-engineer.
- Test what you build; verify what you change.
