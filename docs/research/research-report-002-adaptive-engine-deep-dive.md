# Research Report 002 — Adaptive Engine Deep-Dive

**Status:** Proposed  
**Scope:** OMR template design, CBSE/JEE curriculum taxonomy, and LLM-generated math validation.  
**Research method:** DFS on OMR and validation; BFS on curriculum/data sources.  

---

## 1. Executive Summary

This report deep-dives into three open questions from ADR-001 before it is accepted:

1. **OMR sheet template design** — what physical layout works for low-cost Indian printers and budget phone cameras.
2. **Curriculum taxonomy and question-bank data sources** — how to structure CBSE Class 10/12 and JEE math topics, and where to source seed questions.
3. **LLM math validation** — how to automatically verify generated questions and answers before they reach students.

**Key findings:**

- A **6 mm bubble, 5 mm intra-option gap, 8 mm inter-question gap, 25 mm page margins, and four 15 mm corner markers** is a robust MVP OMR spec.
- **Student ID should be a 5-digit bubble matrix** rather than handwriting or barcode at MVP; it is robust and requires no extra libraries.
- **CBSE Class 10 NCERT gives 15 canonical chapters**; **JEEBench** is an open dataset of 236 JEE-Advanced math questions for calibration/testing.
- **SymPy-based verification** is the highest-leverage MVP guardrail; it raises auto-evaluation accuracy from ~77% to ~86–88% and almost never marks wrong answers as correct.

---

## 2. OMR Template Design (DFS)

### 2.1 Design rules from industry guides

| Rule | Source | Recommendation |
|------|--------|----------------|
| Paper size | OMR Home, Addmen, FormRead | **A4 (210 × 297 mm)** is the default for India. [R15] [R19] |
| Margins | Remark Office OMR, Pyramid Solutions | **25 mm all sides** recommended; never below 12 mm. [R16] |
| Bubble-to-text spacing | Remark Office OMR | ≥ 9.5 mm (3/8 inch) white space around any bubble block. [R16] |
| Bubble-to-bubble spacing | Remark Office OMR, Pyramid Solutions | 1–2 character spaces within a group; ≥ 5 mm practical for phones. [R16] |
| Bubble size | OMR Home, OMRChecker samples | Minimum 2.5 mm; **6 mm diameter** recommended for phone capture. [R15] [R17] |
| Lines/boxes around bubbles | Remark Office OMR | Avoid; if needed use light gray that drops out on threshold. [R16] |
| Print scaling | Addmen | **100% / Actual Size**, disable "Fit to Page". [R19] |
| Corner markers | OMRChecker wiki | Four black square markers improve mobile-camera accuracy. [R17] |

### 2.2 Open-source reference: OMRChecker

OMRChecker uses a `template.json` that maps bubble blocks. A typical sample resizes the page to ~1800×1500 px and uses **40 × 40 px bubbles** (~5 mm at 200 DPI) with **41–59 px horizontal gaps** and **50–60 px vertical gaps** [R17]. For mobile capture it recommends the `CropOnMarkers` preprocessor with a small marker image [R17].

### 2.3 Candidate identification

Options compared:

| Method | Pros | Cons | Verdict |
|--------|------|------|---------|
| Handwritten name/roll | No bubbles used | Requires OCR/ICR; low accuracy on child handwriting. | Avoid |
| 5-digit bubble matrix | Robust, no extra libs, easy to review | Student must mark carefully; up to 5 columns. | **MVP** |
| Pre-printed barcode | Highest accuracy, no student error | Requires barcode generation and printer alignment. | Phase 2 |
| QR code | Can encode full ID and worksheet metadata | Needs QR library; larger print area. | Phase 2 |

### 2.4 Recommended MVP template spec

```
Paper: A4 portrait (210 × 297 mm)
Margins: 25 mm top/bottom/left/right
Corner markers: four 15 × 15 mm solid black squares,
                10 mm from nearest page edge

Header block (top 40 mm):
  - Worksheet title + topic
  - Date bubble block (optional)
  - Student roll number: 10-row × 5-col bubble matrix
    bubble 6 mm, row gap 4 mm, col gap 5 mm

Question block (starting y ≈ 75 mm):
  - 20 MCQ questions, 4 options each (A/B/C/D)
  - Bubble diameter 6 mm
  - Option gap (A→B) 5 mm
  - Question gap 8 mm
  - Left-aligned question numbers

Footer:
  - Instructions: "Fill the bubble completely. No crosses or ticks."
  - Example filled bubble
```

### 2.5 Failure modes and mitigations

| Failure | Mitigation |
|---------|------------|
| Page scaling / Letter size | Force A4 + 100% scale in print dialog; include scaling-check marker if possible. |
| Photocopied gray markers | Print clean originals; do not photocopy forms with gray lines. [R16] |
| Stray marks / crossed answers | Instructions + manual-review flag when multiple bubbles exceed threshold. |
| Partial bubble fill | Use fill-ratio threshold + confidence score; flag low-confidence. |
| Skewed capture | Four corner markers + perspective warp. |

---

## 3. Curriculum Taxonomy & Question-Bank Data Sources (BFS)

### 3.1 CBSE Class 10 NCERT math chapters

The canonical 15 chapters, with approximate board weightage [S1]:

| Unit | Chapter | Weightage |
|------|---------|-----------|
| Number Systems | 1. Real Numbers | 6 |
| Algebra | 2. Polynomials | 20 |
| Algebra | 3. Pair of Linear Equations in Two Variables | 20 |
| Algebra | 4. Quadratic Equations | 20 |
| Algebra | 5. Arithmetic Progressions | 20 |
| Geometry | 6. Triangles | 15 |
| Coordinate Geometry | 7. Coordinate Geometry | 6 |
| Trigonometry | 8. Introduction to Trigonometry | 12 |
| Trigonometry | 9. Some Applications of Trigonometry | 12 |
| Geometry | 10. Circles | 15 |
| Geometry | 11. Constructions | 15 |
| Mensuration | 12. Areas Related to Circles | 10 |
| Mensuration | 13. Surface Areas and Volumes | 10 |
| Statistics & Probability | 14. Statistics | 11 |
| Statistics & Probability | 15. Probability | 11 |

### 3.2 JEE Advanced math topics

Common topic lists from previous-year question aggregators [S3] [S4]:

- Complex Numbers
- Sequences and Series
- Permutations & Combinations
- Matrices and Determinants
- Binomial Theorem
- Trigonometric Ratios, Functions & Equations
- Sets, Relations and Functions
- Limits, Continuity and Differentiability
- Application of Derivatives
- Definite Integrals and Applications
- Differential Equations
- Straight Lines
- Circle
- Conic Sections
- Vector Algebra and 3D Geometry
- Probability
- Statistics

### 3.3 Open datasets

| Dataset | Content | License / Access | Use for Dr. Math |
|---------|---------|------------------|------------------|
| **JEEBench** (DAIR-IITD) | 236 JEE-Advanced math questions (2016–2023), text/LaTeX, with answers [S5] | Open, GitHub | Seed JEE-level questions and benchmark LLM accuracy. |
| **mmJEE-Eval** | 1,460 JEE-Advanced questions (2019–2025), English + Hindi, images [S6] | Research benchmark | Multimodal evaluation; not for direct reuse. |
| **ASSISTments** | K-12 math response logs, skill tags [T8] | Open (varies) | Calibrate adaptive models; mostly US context. |
| **OATutor** | Open-source adaptive algebra content + pipeline [T9] | Open | Reference content pipeline and Q-matrix design. |
| **Aryabhata corpus** (PhysicsWallah) | ~130k cleaned JEE questions [S7] | Proprietary | Not accessible; shows scale of private question banks. |

### 3.4 Recommended taxonomy for MVP

```json
{
  "board": "CBSE",
  "grade": 10,
  "subject": "Mathematics",
  "chapter_id": "ch10_04",
  "chapter_name": "Quadratic Equations",
  "subtopics": [
    { "id": "st_04_01", "name": "Factorisation" },
    { "id": "st_04_02", "name": "Completing the square" },
    { "id": "st_04_03", "name": "Quadratic formula" },
    { "id": "st_04_04", "name": "Nature of roots" }
  ],
  "prerequisites": ["ch10_02", "ch10_03"],
  "exam_weightage_marks": 20
}
```

Each question is tagged with:

- `chapter_id`, `subtopic_id`
- `difficulty` (expert estimate 1.0–5.0, later calibrated via IRT)
- `estimated_time_ms`
- `prerequisite_skills`
- `misconception_tag`
- `answer_type` (mcq4, integer, numeric)
- `source` (JEEBench, NCERT, generated, original)

### 3.5 Seeding strategy

1. Manually create 20–30 questions each for 3 high-weightage Class 10 chapters (Algebra, Trigonometry, Geometry).
2. Import JEEBench math questions for JEE-level seed content.
3. Use LLMs to generate variants from canonical prompts, then apply validation pipeline (§4).
4. Calibrate item difficulty after collecting ~50 responses per question.

---

## 4. LLM Math Validation (DFS)

### 4.1 Failure modes in LLM-generated math

A human evaluation study found the following error distribution [T10]:

| Error type | Share |
|------------|-------|
| Misconception in problem-solving | 36.5% |
| Incorrect provided answer | 17.3% |
| Unclear question definition | 11.5% |
| Calculation error in equation | 9.6% |
| Misinterpretation of question | 7.7% |
| Arithmetic error | 5.8% |
| Absence of necessary diagrams | 3.9% |
| Counting error | 3.9% |

### 4.2 Validation techniques

| Technique | Accuracy / Effect | Notes |
|-----------|-------------------|-------|
| LLM-only judge | ~77% | Tends to false-positive (accept wrong answers). [T11] [T16] |
| **LLM + SymPy** | **86–88%** | Rarely marks wrong as correct; good for algebraic/numeric. [T11] |
| Estimation verification | Catches large errors | Compare rough estimate to symbolic answer within 40–50%. [T12] |
| Outcome reward model + SymPy/LaTeX | Used in RL training | Good pass/fail signal. [T13] |
| Program-of-Thought / SymCode | +13.6 pp over baselines | LLM writes Python/SymPy code, executed in sandbox. [T14] |
| Formal verification (MATH-VF) | High precision but hard | Coq formalization <10% success; simpler formal languages easier. [T15] |

### 4.3 Recommended MVP validation pipeline

```
LLM generates:
  - question_text
  - options[] (for MCQ)
  - correct_answer
  - solution_steps

Step 1: Schema check
  └─ JSON valid? Required fields present?

Step 2: Symbolic verification (SymPy)
  └─ Parse correct_answer and solution_steps.
  └─ Re-derive answer from problem statement if possible.
  └─ Check equivalence (numeric tolerance or symbolic equality).

Step 3: Sanity checks
  └─ Answer is one of the options (MCQ).
  └─ No undefined symbols.
  └─ Question text is self-contained.

Step 4: Estimation check (optional)
  └─ LLM estimates order of magnitude; compare to computed answer.

Step 5: Human review queue
  └─ Flag items where Step 2 or Step 3 fails.
  └─ Spot-check 10% of passing items.
```

### 4.4 Difficulty estimation before calibration

Until real student responses are available, use a composite heuristic:

- Expert tag (1.0–5.0)
- Operation count (+0.2 per non-trivial step)
- Word count / reading complexity (+0.1 if above median)
- Prerequisite depth (+0.2 per prerequisite chapter)

Update with 1PL IRT after 50+ responses per item.

---

## 5. Implications for ADR-001

| ADR-001 element | Updated guidance |
|-------------------|------------------|
| OMR microservice | Build around a 6 mm bubble, 4-marker A4 template; use 5-digit roll-number matrix. |
| Question bank | Seed from CBSE NCERT chapters + JEEBench; tag with subtopic, difficulty, misconception, prerequisite. |
| LLM question generation | Add SymPy-based verification step before any question is stored or printed. |
| IRT calibration | Start with expert-tagged difficulty; calibrate after 50 responses per item. |

---

## 6. References

### [R] OMR / Template

- [R15] OMR Home — Size and dimension of an OMR Sheet — omrhome.com/blog/omr-sheet-size-and-dimension
- [R16] Remark Office OMR User's Guide / Pyramid Solutions — spacing and margin best practices — remarksoftware.com, pyramidsolutions.com
- [R17] OMRChecker wiki — template.json and CropOnMarkers — github.com/Udayraj123/OMRChecker/wiki
- [R18] Addmen — Design of OMR Answer Sheet — addmengroup.com/omr-design/design-of-answer-sheet.htm
- [R19] Addmen — Precautions for OMR Printing — addmengroup.com/omr-printing/precautions-for-printing.htm
- [R20] PyImageSearch — Bubble sheet scanner with Python and OpenCV — pyimagesearch.com/2016/10/03/bubble-sheet-multiple-choice-scanner-and-test-grader-using-omr-python-and-opencv

### [S] Syllabus / Data

- [S1] eSaral — NCERT Class 10 Maths Syllabus 2025 — esaral.com/class-10-maths-ncert-book-pdf
- [S2] CBSE Academic — NCERT Solutions Class 12 Maths — cbseacademic.in
- [S3] EduRev — JEE Advanced Previous Year Questions — edurev.in/t/514541
- [S4] eSaral — Math Topic-wise JEE Advanced PYQs — esaral.com/math-topic-wise-jee-advanced-previous-year-question-with-solutions
- [S5] DAIR-IITD / JEEBench — github.com/dair-iitd/jeebench
- [S6] mmJEE-Eval — emergentmind.com/topics/jee-for-stem
- [S7] Aryabhata 1.0 — arxiv.org/html/2508.08665v1

### [T] Validation / Algorithms

- [T8] pyKT / EduKTM benchmark datasets — github.com/pykt-team/pykt-toolkit
- [T9] OATutor — oatutor.org
- [T10] Human evaluation of LLM math errors — arxiv.org/pdf/2310.13615
- [T11] MathViz-E / Automated Graphing System — LLM+SymPy autoevaluator — arxiv.org/pdf/2407.17544
- [T12] Estimation verification — arxiv.org/pdf/2509.18565
- [T13] Outcome reward model with SymPy checks — arxiv.org/html/2412.06845v3
- [T14] SymCode — neurosymbolic code generation for math — arxiv.org/html/2510.25975v2
- [T15] MATH-VF — formal verification for LLM math — arxiv.org/html/2505.20869v1
- [T16] Can Small Language Models Judge as Well as Large Ones? — arxiv.org/html/2606.07810v1
