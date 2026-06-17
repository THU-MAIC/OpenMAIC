# ADR-003 — Board-Aware Worksheet Generation

**Status:** Proposed  
**Date:** 2026-06-04  
**Author:** Research Agent Synthesis  
**Related:** `docs/research/research-report-003-state-board-syllabus-mapping.md`, `docs/research/research-report-005-dpdp-jee-omr-deep-dive.md`

---

## Context

Dr. Math’s worksheet MVP currently generates PDFs for a generic topic. To serve Indian schools and tuition centres, the engine must produce questions that are **aligned to the student’s board** (CBSE, Maharashtra, Karnataka, Tamil Nadu, UP, Bihar, etc.) without maintaining six independent syllabi.

Research Report 003 found that ~80 % of Class 10 Mathematics topics overlap across boards, but **chapter ordering, mark weightage, proof expectations, excluded topics, and language medium differ**. Research Report 005 adds that a multi-year prerequisite graph is needed for JEE foundation tracks.

This ADR records the decision on how to model curricula and inject board context into worksheet generation.

---

## Decision

We will implement a **canonical curriculum graph + per-board overlay** architecture:

1. **Canonical graph** stores shared concepts, prerequisites, difficulty ceilings, and cross-grade dependencies (Class 9 → 12).
2. **Board overlay** stores per-board sequencing, mark weight, excluded/reduced topics, proof level, and supported mediums.
3. **Track overlay** distinguishes `board`, `jee_foundation`, and `neet_foundation` difficulty framing.
4. **Prompt injection** prepends a `board_context` block to the LLM prompt, including board, grade, medium, topic, excluded topics, and answer formats.
5. **Question tagging** stores `canonical_topic`, `boards`, `tracks`, `difficulty`, `marks_type`, and `prerequisites` for every generated question.

### Why this design?

- **Content reuse:** One canonical node can serve multiple boards, reducing LLM prompt size and maintenance burden [R3].
- **Accurate alignment:** Board overlays prevent out-of-syllabus questions (e.g., CBSE-reduced Constructions) and mirror local exam patterns [R3].
- **Future-proofing:** The same graph supports JEE foundation, NEET foundation, and future grades by adding edges, not duplicating content [R5].
- **DPDP-friendly:** Storing board/grade/medium preferences is not sensitive personal data; student names/IDs remain pseudonymized [R5].

---

## Consequences

### Positive

- Worksheets feel native to each board and medium.
- Teachers can trust that reduced-syllabus exclusions are respected.
- Adaptive paths use a stable prerequisite graph independent of board variations.
- JEE foundation students get higher-difficulty framing on the same canonical topics.

### Negative / Trade-offs

- Requires manual annual curation against official board PDFs until official APIs exist.
- Regional-language generation adds LLM cost and quality risk.
- Board overlays must be validated before each academic year.

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Independent syllabus per board | High maintenance; divergence in content is smaller than it appears [R3]. |
| Generic CBSE-only default | Misaligns state-board students and weakens tuition-center sales. |
| No prerequisite graph | Adaptive engine would be reduced to simple streak-based difficulty. |
| Hard-code board context in prompt templates | Fragile; structured overlays enable validation and reuse. |

---

## Implementation Sketch

```
┌─────────────────────────────────────────────────────────────┐
│  REQUEST                                                    │
│  • student roster + board + grade + medium + track          │
│  • topic + excluded topics + question types/count           │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  CURRICULUM SERVICE                                         │
│  • Load canonical topic node                                 │
│  • Apply board overlay (exclusions, weight, proof level)     │
│  • Apply track overlay (difficulty ceiling)                  │
│  • Validate: excluded topics are not in generated set        │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  LLM PROMPT                                                 │
│  • Board context block                                       │
│  • Topic + prerequisites + answer formats                    │
│  • Explicit exclusion list                                   │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  PDF OUTPUT                                                 │
│  • Board-specific header and instructions                    │
│  • Standard OMR strip (ADR-001 + Report 005)                 │
│  • Answer key with board-acceptable steps                    │
└─────────────────────────────────────────────────────────────┘
```

### Data Schema (suggested)

```yaml
canonical:
  topics:
    - id: quadratic_equations
      name: Quadratic Equations
      prerequisites: [polynomials, real_numbers]
      next: [complex_numbers_11, sequences_11]
      difficulty_ceiling: 5
      tracks: [board, jee_foundation]

boards:
  cbse:
    grade_10:
      math:
        topic_overrides:
          quadratic_equations:
            marks: 20   # within Algebra unit
            proof_level: proof
            excluded_subtopics: []
            answer_formats: [mcq, short, long]
            mediums: [en, hi]
          constructions:
            excluded: true
```

---

## References

- [R3] `docs/research/research-report-003-state-board-syllabus-mapping.md`
- [R5] `docs/research/research-report-005-dpdp-jee-omr-deep-dive.md`
