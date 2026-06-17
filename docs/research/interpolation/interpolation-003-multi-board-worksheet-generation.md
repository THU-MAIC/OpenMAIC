# Interpolation-003 — Multi-Board Worksheet Generation

**Date:** 2026-06-04  
**Research Phase:** Interpolation — connecting canonical curriculum graph to per-board worksheet outputs

---

## 1. The Interpolation Problem

Given one canonical topic graph, how do we generate a worksheet that feels native to a CBSE student in Delhi, a Maharashtra-board student in Pune, or a Tamil Nadu-board student in Chennai?

The answer is a **three-layer interpolation pipeline**:

1. **Canonical model** — shared concepts, prerequisites, difficulty levels.
2. **Board overlay** — sequencing, mark weight, excluded topics, medium, proof expectations.
3. **Student overlay** — prior performance, grade, time available, competitive track.

---

## 2. Prompt Template Sketch

```markdown
You are Dr. Math, a Class 10 worksheet generator for Indian boards.

Board context:
- Board: {{board}}
- Medium of instruction: {{medium}}
- Current unit: {{unit}}
- Reduced/excluded topics: {{excluded}}
- Mark weight emphasis: {{weightage}}
- Answer formats to include: {{formats}}
- Number of questions: {{count}}
- Difficulty distribution: {{difficulty_dist}}

Rules:
1. Use board-appropriate terminology (e.g., "Arithmetic Progression" vs "Samantar Shreni" for Hindi medium).
2. Do not include excluded topics.
3. Mirror the board’s typical question format (MCQ/short/long).
4. Provide a separate answer key with step-by-step solutions.

Generate the worksheet in HTML-friendly Markdown.
```

---

## 3. Example: Same Canonical Topic, Two Outputs

**Canonical topic:** Quadratic Equations

### CBSE output framing
- 1 mark MCQ on nature of roots
- 2 mark short-answer on factorisation
- 3 mark application problem
- 4 mark proof/problem on discriminant

### Maharashtra output framing
- Algebra-section problem with exact 2-mark / 3-mark split
- Include a word problem reducible to quadratic form
- Emphasize equations reducible to quadratic form

### Tamil Nadu output framing
- Real-life application problem
- 5-mark long answer with detailed steps

---

## 4. Implementation Notes

- Store board overlays in `data/boards/` as JSON/YAML.
- Use the same `buildWorksheetHTML` template but inject board-specific headers and instructions.
- Add a `boardContext` field to the `generate-worksheet-pdf` API.
- Validate excluded topics against the canonical graph before calling the LLM.
