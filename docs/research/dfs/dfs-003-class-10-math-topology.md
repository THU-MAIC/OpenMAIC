# DFS-003 — Class 10 Mathematics Topic Topology & Board Deltas

**Date:** 2026-06-04  
**Research Phase:** DFS — deep-dive into topic dependencies and board-specific variations

---

## 1. Canonical Dependency Graph

A plausible mastery order for the shared Class 10 backbone:

```
Real Numbers
    └─> Polynomials
            └─> Pair of Linear Equations
                    └─> Quadratic Equations
            └─> Arithmetic Progression
    └─> Coordinate Geometry
            └─> Geometry (Triangles/Similarity, Circles)
                    └─> Constructions
                    └─> Mensuration (Areas & Volumes)
            └─> Trigonometry
                    └─> Heights & Distances
                    └─> Mensuration (surface-area problems)
Statistics
Probability
```

**Pedagogical rationale:** Number-system fluency feeds algebra; algebra and coordinate geometry feed geometry; geometry feeds trigonometry and mensuration; statistics and probability are largely independent.

---

## 2. Board-Specific Deltas

### CBSE (2025–26)

- **Reduced content:** Constructions largely removed; some geometry theorems stated without proof.[^1]
- **Focus:** Application + HOTS; Standard paper aligns with JEE foundation.
- **Internal assessment:** 20 marks via periodic tests, portfolio, lab activities.

### Maharashtra (MSBSHSE)

- **Algebra (40 marks):** AP, GP, Quadratic Equations, Linear Equations, Probability, Statistics (with normal distribution).[^2]
- **Geometry (40 marks):** Similarity, Circle, Coordinate Geometry, Constructions, Trigonometry, Mensuration.
- **Notable additions:** Geometric Progression, normal distribution, Cramer’s rule for 2×2 linear systems.

### Karnataka (KSEAB)

- **High-weight chapters:** Triangles (8), Linear Equations (8), Surface Areas & Volumes (7).[^3]
- **Constructions retained** (5 marks) unlike CBSE.
- **Lower weight:** Probability (3), Areas Related to Circles (3).

### Tamil Nadu (DGE TN)

- **100 % theory for Maths** — no internal break-up.[^4]
- **Samacheer Kalvi** sequencing emphasizes “Number Systems & Sequences” early.
- **Emphasis on real-life application problems** in the 2025–26 update.

### Uttar Pradesh (UPMSP)

- **70/30 theory/internal split** — project work is mandatory.[^5]
- **NCERT-based** but exam questions often repeat previous-year patterns.
- **Construction and lab activities** carry internal-marks weight.

### Bihar (BSEB)

- **Textbook-centric** — direct questions from SCERT Bihar books.[^6]
- **Less application/HOTS** than CBSE.
- **Hindi-medium dominance** in rural areas.

---

## 3. Overlap Matrix (Shared vs Unique)

| Topic | Shared? | Unique Notes |
|-------|---------|--------------|
| Real Numbers | ✅ All | UP adds Euclid’s division lemma emphasis |
| Polynomials | ✅ All | — |
| Linear Equations | ✅ All | Maharashtra adds Cramer’s rule |
| Quadratic Equations | ✅ All | — |
| AP | ✅ All | Maharashtra also covers GP |
| Coordinate Geometry | ✅ All | — |
| Similarity/Triangles | ✅ All | — |
| Circles | ✅ All | CBSE reduced some tangent proofs |
| Constructions | ⚠️ Most | CBSE largely removed |
| Trigonometry | ✅ All | — |
| Mensuration | ✅ All | Karnataka weights surface area/volume higher |
| Statistics | ✅ All | Maharashtra includes normal distribution |
| Probability | ✅ All | — |

---

## 4. Implications for the Adaptive Engine

- **Prerequisites should be canonical**, not board-specific, to maximize content reuse.
- **Difficulty calibration** can use board-specific mark weightage as a proxy for exam importance.
- **Question format overlays:**
  - CBSE → case-based/competency MCQs + long answers.
  - Maharashtra → Algebra/Geometry section balance.
  - Tamil Nadu → 100-mark practice pacing.
  - UP/Bihar → direct textbook-style practice.
- **Board-specific exclusions** (e.g., CBSE Constructions) must be filtered before PDF generation.
