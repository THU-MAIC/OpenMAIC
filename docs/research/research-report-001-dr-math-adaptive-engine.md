# Research Report 001 — Dr. Math Adaptive Engine

**Status:** Proposed  
**Scope:** Personalized worksheet + OMR-scan + adaptive-next-worksheet loop for Indian K-12 and test-prep.  
**Research method:** BFS competitive landscape, DFS technology deep-dives (OMR, adaptive algorithms), bidirectional GTM/curriculum analysis.  

---

## 1. Executive Summary

The user’s vision is a **continuous adaptive assessment loop**:

> “There is a mark. When a kid runs out of time or can’t solve it, the next question should adapt. Questions customize according to the kid’s brain and how it’s evolving.”

This report fuses that pedagogical vision with research from five parallel research agents:

1. **Competitive landscape** for AI worksheets / adaptive practice in India.
2. **Mobile OMR / bubble-sheet scanning** technology.
3. **Adaptive question selection** and cognitive diagnosis algorithms.
4. **Ed-tech SaaS pricing and go-to-market** in India.
5. **Curriculum and question-bank data sources** for Indian boards.

**Key finding:** No existing Indian market leader tightly integrates AI worksheet generation → print → OMR scan → instant grading → adaptive next worksheet. Major players are video-first; worksheets are supplementary. Standalone OMR tools grade but do not feed adaptive learning loops. This is the gap Dr. Math can own.

---

## 2. The Core Concept: The “Mark”

A **Mark** is a multi-dimensional, continuously updated state vector for one student on one topic.

```json
{
  "student_id": "student_123",
  "topic": "integers",
  "dimensions": {
    "accuracy_rate": 0.72,
    "avg_response_time_ms": 45000,
    "hints_needed_ratio": 0.15,
    "irt_ability_theta": 0.42,
    "mastery_probability": 0.68,
    "current_difficulty_estimate": 2.3,
    "mastery_level": "building",
    "last_error_type": "sign_confusion",
    "streak_correct": 2,
    "streak_wrong": 0,
    "confidence_trend": "rising",
    "known_gaps": ["number_line_negatives"],
    "spaced_repetition_due": []
  },
  "question_history": [
    {
      "question_id": "int_001",
      "correct": true,
      "time_ms": 32000,
      "hints_used": 0,
      "difficulty": 2,
      "error_type": null
    }
  ]
}
```

### Dimensions and evidence

| Dimension | Why it matters | Research basis |
|-----------|----------------|----------------|
| **Accuracy / streak** | 3 correct → harder; 2 wrong → easier or prerequisite review. | Bloom (1984) mastery learning [T1] |
| **Response time** | Fast + correct → mastery; slow + wrong → struggle or anxiety. | Murray & Arroyo (2002) [T2] |
| **Hints used** | Hint vector decay indicates fading scaffolding. | Wood et al. (1976) [T3] |
| **Error type** | Repeated error triggers targeted micro-lesson. | ACEM error-pattern work, Kapur productive failure [T4] |
| **IRT ability θ** | Continuous ability estimate; replaces rigid level buckets. | Rasch / 1PL IRT [T5] |
| **BKT mastery probability** | Explicit skill-level mastery state for diagnostic reporting. | Corbett & Anderson (1994), pyBKT [T6] |
| **Confidence trend** | Long pause + wrong = anxiety; fast wrong = overconfidence. | Warshauer (2015) [T7] |

---

## 3. Competitive Landscape (BFS)

### India — large platforms

| Player | Relevant offering | Gap relative to Dr. Math |
|--------|-------------------|--------------------------|
| **BYJU’S / Toppr** | Interactive worksheets, chapter tests, parent dashboard, adaptive practice. | Video-first; worksheets are add-ons; no tight OMR-scan loop. [R1] |
| **Physics Wallah** | DPPs, practice sheets, test series, low-cost batches. | Content bundles, not AI-personalized per-student worksheets. [R2] |
| **Vedantu** | Ved AI assistant, ScoreBooster, personalized homework. | No OMR integration; homework is digital-first. [R3] |
| **Unacademy** | DPPs, mock tests, structured courses. | Test-prep content library, not school worksheet automation. [R4] |
| **Doubtnut** | Image-based doubt solving in vernacular languages. | Doubt solver, not worksheet generator or grader. [R5] |
| **Khan Academy India** | Free NCERT/CBSE-aligned mastery practice, Khanmigo pilot. | Free digital practice; no Indian school OMR/print workflow. [R6] |
| **iDream Education / iPrep PAL** | Offline-first adaptive learning for schools. | School-focused but not worksheet + OMR loop. [R7] |

### Global

| Player | Relevant offering | Gap |
|--------|-------------------|-----|
| **IXL** | SmartScore adaptive K-12 practice. | No print/OMR workflow for Indian schools. [R8] |
| **Khan Academy** | Mastery-based progression. | Same as above. |

### OMR-only tools

- **Addmen**, **Verificare (OMR Home)**, **ScoreExamOMR**, **EasyAssess** — design, scan, grade OMR sheets, but disconnected from worksheet generation or adaptive follow-up. [R9]

### Opportunity statement

> Build a lightweight, affordable, **AI worksheet generator for Indian schools and tuition centers** that prints custom sheets, scans OMR answer sheets via phone, and auto-adjusts the next worksheet based on results. No incumbent owns this exact closed loop.

---

## 4. Technology Deep-Dive: Mobile OMR Scanning (DFS)

### Options evaluated

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Server-side Python + OpenCV (OMRChecker-style)** | Highest accuracy (~90–100% on clean scans, ~98–99% in YOLO+IP systems), fast iteration, no app-store release. | Requires upload bandwidth, backend compute. | **Recommended for MVP.** [R10] [R11] |
| **Browser OpenCV.js / Web Worker** | No backend image compute, instant feedback. | Accuracy harder to tune, limited preprocessing power. | Viable for light verification; not grading. [R12] |
| **Commercial SDK (LEADTOOLS, Nutrient)** | Cross-platform, robust keystone correction. | Licensing cost, vendor lock-in. | Evaluate after MVP if accuracy gap remains. [R13] [R14] |
| **On-device ML** | Privacy, offline, low bandwidth. | Model size/thermal constraints, slower iteration. | Phase-2 option. |

### Recommended architecture

```
Phone camera with frame overlay
       │
       ▼
Guided capture (4 corner markers visible)
       │
       ▼
Compress + upload to /api/omr/grade
       │
       ▼
Server-side OpenCV pipeline
  ├─ grayscale / blur / adaptive threshold
  ├─ corner-marker detection → perspective warp
  ├─ grid segmentation using template.json
  ├─ bubble fill-ratio detection + confidence score
  └─ flag ambiguous answers
       │
       ▼
Return { answers[], confidence[], annotated_image }
       │
       ▼
Update Mark → generate next worksheet
```

### Failure modes and mitigations

| Failure | Mitigation |
|---------|------------|
| Lighting / shadows | Adaptive threshold, CLAHE, capture guidance. |
| Skew / keystone | Four corner markers + perspective transform. |
| Partial / faint bubbles | Fill-ratio thresholds + confidence flags. |
| Low-resolution camera | Require ≥2 MP, autofocus, minimum distance. |
| Stray marks / multiple bubbles | Contour filtering + manual-review fallback. |
| Print distortion / folds | Flexible template or YOLO region detection. |

---

## 5. Adaptive Algorithm Deep-Dive (DFS)

### Candidate algorithms

| Algorithm | Best for | Complexity | Interpretability |
|-----------|----------|------------|------------------|
| **1PL / Rasch IRT** | Continuous ability estimation, next-item selection. | Low | High |
| **Bayesian Knowledge Tracing (BKT)** | Skill-level mastery states. | Medium | High |
| **Deep Knowledge Tracing (DKT)** | Large-scale predictive accuracy. | High | Low |
| **Cognitive Diagnosis Models (DINA/G-DINA)** | Granular misconception profiles. | High | Medium |
| **Performance Factors Analysis (PFA)** | Quick logistic baseline. | Low | Medium |

### Recommendation: hybrid 1PL IRT + BKT

- **1PL IRT** drives real-time question selection: estimate student ability θ after each response, pick the item that maximizes Fisher information at current θ. Simple, research-backed, avoids rigid difficulty buckets. [T5]
- **BKT** drives mastery reporting per skill: maintain P(mastery) for each learning objective, trigger worksheet advancement when probability crosses threshold (e.g., 0.85–0.95). [T6]
- **PFA-style features** (prior successes/failures per misconception) handle error-type targeting and micro-lessons.

### Question-selection scoring function

```python
def score_question(mark, question, now_ms):
    score = 0

    # 1. IRT information — most important
    info = fisher_information(mark.irt_ability_theta, question.irt_difficulty)
    score += 20 * info

    # 2. Skill mastery gate
    if question.skill in mark.known_gaps:
        score += 12

    # 3. Misconception targeting
    if question.misconception_tag == mark.last_error_type:
        score += 10

    # 4. Time fit
    if question.estimated_time_ms <= mark.avg_response_time_ms * 1.2:
        score += 5

    # 5. Recent exposure penalty
    if question.id in mark.recent_question_ids:
        score -= 15

    # 6. Spaced repetition boost
    if question.id in mark.spaced_repetition_due:
        score += 8

    return score
```

### Timeout handling

```python
def handle_timeout(mark, question):
    if question.difficulty > mark.current_difficulty_estimate:
        # Hard question timeout is expected; lower estimate slightly.
        mark.irt_ability_theta -= 0.15
        return "easier_variant_same_concept"
    else:
        # Easy question timeout suggests anxiety/distraction.
        mark.confidence_trend = "anxious"
        return "same_difficulty_rephrased"
```

---

## 6. Go-to-Market and Pricing (Bidirectional)

### India ed-tech pricing signals

| Segment | Model | Typical price |
|---------|-------|---------------|
| Private schools | Per student / year | ₹100 – ₹1,000 |
| Private schools | Flat per-school / year | ₹1 – ₹5 lakh |
| Private schools | Per teacher / year | ₹500 – ₹2,000 |
| Tuition / coaching | Per student / month | ₹12 – ₹120 (₹144 – ₹1,440/yr) |
| Tuition / coaching | Center SaaS / month | ₹4,000 – ₹25,000+ |

Source: RAYSolute, NextOS, AllCoaching, upGrowth. [G1] [G2] [G3] [G4]

### Sales cycle

- **Schools:** 4–9 months. Lead → demo → 1–3 month pilot → business case → negotiation → implementation.
- **Tuition centers:** Faster, owner-driven, but price-sensitive.
- **Academic calendar matters:** Budgets finalize April–May; implementation June–July. [G1]

### Stakeholder map

| Stakeholder | Pain / buying criteria |
|-------------|------------------------|
| **Teacher** | Workload reduction, ease of use, accurate diagnostics. Champion, not signer. |
| **Principal / Head** | Board/NEP compliance, parent satisfaction, outcome metrics. |
| **Trustee / Director** | ROI, enrollment growth, brand prestige. |
| **Parent** | Better outcomes, visibility, affordability (indirect buyer). |

### Failure modes to avoid

- Demoing only teachers and skipping the principal. [G1]
- Free pilots (convert ~40%) vs. paid metric-driven pilots (convert 60–70%). [G1]
- Quoting in USD, ignoring local language, overbuilding before product-market fit. [G5]

### Recommended initial beachhead

Start with **tuition centers and one anchor private school** (e.g., Natalmanjaya High School). Tuition centers are results-driven, owner-decided, and can show fast outcome data. Schools provide credibility and larger contracts once proof exists.

---

## 7. Curriculum and Question-Bank Strategy (BFS)

### Data sources

| Source | Content | Structure |
|--------|---------|-----------|
| **NCERT / CBSE official** | Syllabi, chapter lists, sample papers. | PDF/HTML; needs scraping and normalization. |
| **State board sites** | Syllabi, previous papers. | Fragmented; one scraper per board. |
| **Open datasets** | ASSISTments, Junyi Academy, EdNet, FoundationalASSIST. | Rich response data, mostly US/Chinese contexts; needs Indian localization. [T8] |
| **OATutor** | Open-source adaptive algebra tutor, content pipeline, LTI. | Reference architecture. [T9] |

### MVP question-bank plan

1. **Seed manually** for 3–5 high-value topics (e.g., Class 10 CBSE algebra, geometry, trigonometry) with 50–100 questions each.
2. **Tag every question** with:
   - `topic`, `sub_topic`, `skill`
   - `irt_difficulty` (calibrated via pilot responses)
   - `estimated_time_ms`
   - `prerequisite_skills`
   - `misconception_tag`
   - `adaptive_tags` (visual, word_problem, multi_step, etc.)
3. **Use LLMs to generate variants** from a canonical prompt bank, then human-review for correctness and difficulty.
4. **Calibrate difficulty** after ~50 responses per question using 1PL IRT.

---

## 8. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Next.js)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ /students    │  │ /worksheet   │  │ /batch-worksheets    │  │
│  │ roster CRUD  │  │ generate PDF │  │ class-level PDFs     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ OCR marksheet scan modal + OMR capture + review screen   │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      NEXT.JS API LAYER                          │
│  • /api/students        (CRUD + Dexie sync)                     │
│  • /api/generate-worksheet-pdf  (LLM + PDF)                     │
│  • /api/omr/grade       (image → answers)                       │
│  • /api/adaptive/next   (Mark → next worksheet)                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   ┌─────────────────┐ ┌──────────────┐ ┌──────────────┐
   │ LLM service     │ │ OMR service  │ │ Adaptive     │
   │ (OpenAI/etc.)   │ │ Python/FastAPI│ │ engine       │
   │ question gen    │ │ OpenCV/OMRChecker│ │ IRT + BKT │
   └─────────────────┘ └──────────────┘ └──────────────┘
```

### Storage

- **Server:** PostgreSQL for students, marks, sessions, question bank, response logs.
- **Client:** Dexie (IndexedDB) + Zustand for offline roster and cached worksheets.
- **Object storage:** S3/MinIO for scanned OMR images and annotated grading output.

---

## 9. Roadmap

### Phase 0 — Foundation (now)
- [ ] Adopt research-first covenant and ADR process.
- [ ] Migrate existing `docs/decisions/DECISION-*.md` to `docs/adrs/ADR-###-*.md` with numbered citations.
- [ ] Stabilize current worksheet PDF generation and student roster.

### Phase 1 — Static Adaptive Worksheets
- [ ] Build question bank with difficulty/misconception/prerequisite tags for 3 CBSE Class 10 topics.
- [ ] Add `/api/adaptive/next` using simple rule-based Mark (streak + error type).
- [ ] Add student-facing `/practice` page: one question at a time, record response + time.

### Phase 2 — OMR Scan Loop
- [ ] Design printable OMR template with 4 corner markers.
- [ ] Stand up Python/FastAPI OMR microservice (OpenCV + OMRChecker-style pipeline).
- [ ] Mobile capture screen + upload + review ambiguous answers.
- [ ] Feed OMR results back into Mark and generate next worksheet.

### Phase 3 — Psychometric Adaptive Engine
- [ ] Implement 1PL IRT parameter estimation and Fisher-information selection.
- [ ] Add BKT per skill for mastery reporting.
- [ ] Calibrate item difficulties from real response data.

### Phase 4 — SaaS Multi-Tenancy
- [ ] School/centre tenant isolation, role-based access.
- [ ] Parent dashboard, teacher analytics, outcome reports.
- [ ] Billing and subscription tiers.

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| OMR accuracy on low-end phones | Server-side processing, confidence flags, manual review fallback. |
| LLM generates incorrect math | Structured output + post-hoc validation (MathJax/SymPy). |
| Difficulty calibration requires data | Launch with expert-tagged difficulties; update via IRT after 50+ responses. |
| School sales cycle is long | Start with tuition centers + one anchor school. |
| Data privacy (FERPA/GDPR) | No PII in logs; encrypted storage; consent workflow. |
| Vernacular support | Phase-1 English/Hindi; add regional languages per board expansion. |

---

## 11. References

### [T] Pedagogy / Algorithms

- [T1] Bloom, B. S. (1984). “The 2 Sigma Problem.” Search for mastery learning research summaries.
- [T2] Murray, R. C., & Arroyo, I. (2002). “Toward Measuring and Maintaining the Zone of Proximal Development in Adaptive Instructional Systems.”
- [T3] Wood, D., Bruner, J. S., & Ross, G. (1976). “The Role of Tutoring in Problem Solving.”
- [T4] Kapur, M. (2008). “Productive Failure.”
- [T5] Rasch / 1PL IRT introduction — assess.com/what-is-item-response-theory
- [T6] Corbett, A. T., & Anderson, J. R. (1994). “Knowledge Tracing.”
- [T7] Warshauer, H. K. (2015). “Productive Struggle in Middle School Mathematics Classrooms.”
- [T8] pyKT / EduKTM benchmark datasets — github.com/pykt-team/pykt-toolkit
- [T9] OATutor open-source adaptive tutor — oatutor.org

### [R] Competitive / Market

- [R1] BYJU’S acquires Toppr — ciol.com/byjus-acquire-edtech-rival-toppr-150-mn-deal-report
- [R2] Physics Wallah Lakshya JEE batch — pw.live
- [R3] Vedantu launches Ved AI assistant — fortuneindia.com/business-news/vedantu-launches-ved-to-deliver-ai-driven-personalised-learning-across-india/128150
- [R4] Unacademy — unacademy.com
- [R5] Doubtnut vernacular doubt solving — edtechreview.in/news/doubtnut-partners-with-swiftchat
- [R6] Khan Academy India — cosmoschool.ai/feeds/blog/best-edtech-platform-cbse-schools
- [R7] iDream Education iPrep PAL — idreameducation.org/iprep-pal
- [R8] IXL pricing and reviews — myengineeringbuddy.com/blog/ixl-learning-reviews-pricing-2026-honest-look
- [R9] Addmen OMR software comparison — addmengroup.com/omr

### [O] OMR Technology

- [R10] OMRChecker (Udayraj123) — github.com/Udayraj123/OMRChecker
- [R11] YOLO + image processing OMR system — ijert.org/a-web-based-automated-omr-evaluation-system-using-yolo-and-image-processing-techniques
- [R12] @armghan3071/omrchecker npm client-side OMR — libraries.io/npm/@armghan3071%2Fomrchecker
- [R13] LEADTOOLS OMR SDK — leadtools.com/sdk/ocr/omr
- [R14] Nutrient OMR SDK — nutrient.io/sdk/omr

### [G] Go-to-Market

- [G1] RAYSolute — EdTech India Go-to-Market Strategy for Schools — raysolute.com/edtech-india-go-to-market-schools.html
- [G2] RAYSolute — B2B EdTech Sales Strategy — raysolute.com/edtech-b2b-sales-strategy-schools.html
- [G3] NextOS — Coaching ERP Software Pricing — nextos.in/coaching-erp-software.html
- [G4] AllCoaching — Affordable LMS Cost Guide — allcoaching.in/blog/affordable-lms-for-independent-educators
- [G5] Schoolnet India — 6 Reasons EdTech Companies in India Struggle — schoolnetindia.com/blog/6-reasons-why-edtech-companies-in-india-struggle
