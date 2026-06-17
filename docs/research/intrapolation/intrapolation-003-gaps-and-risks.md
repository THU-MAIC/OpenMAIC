# Intrapolation-003 — Gaps, Risks & Internal Critique

**Date:** 2026-06-04  
**Research Phase:** Intrapolation — internal critique of the state-board mapping research

---

## 1. Data Quality Gaps

- **No live official APIs:** All board syllabi are distributed as PDFs or static pages. Parsing them at scale is brittle.
- **Aggregator variance:** Third-party sites disagree on exact mark weightage; only official board blueprints are authoritative.
- **Reduced-syllabus lag:** Post-COVID reduced syllabi may still be referenced by outdated content sites.
- **Regional-medium gaps:** Our search was English-dominant; Hindi/Marathi/Kannada/Tamil textbook equivalents may use different terminology.

## 2. Product Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Wrong board context in prompt | Student receives out-of-syllabus questions | Prompt validation + teacher review workflow |
| Hallucinated board-specific facts | Loss of trust, exam harm | Ground LLM in curated `curriculum-graph` |
| Missing reduced-syllabus exclusions | Student wastes time on deleted topics | Annual audit against official PDFs |
| Over-generalizing CBSE as default | State-board students get misaligned practice | Always require explicit `board` parameter |
| Language mismatch | Non-English-medium students struggle | Generate in student medium when available |

## 3. What We Did Not Research

- State-specific Class 12 / JEE syllabi mapping.
- ICSE / IB / NIOS boards.
- Exact official blueprints (chapter-wise marks) for all six boards — we relied on aggregator summaries.
- Legal opinion on reproducing official SCERT content.

## 4. Recommended Validation Steps

1. Download official 2025–26 PDFs for at least CBSE, Maharashtra, Karnataka, and Tamil Nadu.
2. Extract topic lists into a structured YAML file.
3. Cross-check against two independent aggregators.
4. Pilot with one board (e.g., CBSE) before adding state-board overlays.
5. Add a teacher-facing “flag out-of-syllabus question” button.

## 5. Conclusion

The state-board mapping is **directionally correct and product-actionable**, but it is not yet authoritative. Treat the canonical graph as a working hypothesis and the board overlays as user-configurable layers.
