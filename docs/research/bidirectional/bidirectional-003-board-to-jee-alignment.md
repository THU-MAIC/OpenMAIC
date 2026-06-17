# Bidirectional-003 — Board-to-Competitive Exam Alignment

**Date:** 2026-06-04  
**Research Phase:** Bidirectional — cross-connect state-board curriculum with competitive-exam foundation

---

## 1. The Competitive Baseline

JEE Main/Advanced and NEET draw heavily from the **NCERT Class 10–12 backbone**. Since CBSE follows NCERT, CBSE-aligned practice automatically serves the largest competitive-prep cohort. State-board students targeting JEE/NEET often supplement with NCERT/CBSE material, creating a natural convergence point.

---

## 2. Bidirectional Mapping Table

| State-Board Topic | JEE/NEET Relevance | Dr. Math Implication |
|-------------------|--------------------|----------------------|
| Real Numbers / HCF-LCM | Foundation for number theory | Keep as prerequisite for algebra |
| Polynomials | JEE: quadratic/cubic roots, inequalities | Offer higher-difficulty polynomial problems |
| Linear Equations (2 vars) | JEE: coordinate geometry, matrices intro | Include systems with parameters |
| Quadratic Equations | High JEE weight | Add discriminant/graph/range variants |
| AP / GP | JEE sequences & series core | Maharashtra GP is directly JEE-relevant |
| Coordinate Geometry | JEE straight lines, circles foundation | Add JEE-style locus/distance problems |
| Similarity / Triangles | JEE geometry (limited direct weight) but logical proofs | Maintain proof-based variants |
| Circles | JEE conic-sections precursor | Tangents/chords as bridge problems |
| Trigonometry | Very high JEE/NEET weight | Add identities, equations, inverse-trig bridges |
| Mensuration | NEET physics units; JEE 3D geometry precursor | Keep applied/unit-conversion problems |
| Statistics & Probability | JEE probability foundation; NEET biostatistics | Add conditional-probability bridges |

---

## 3. Strategic Insight

Dr. Math can **bidirectionally serve** two customer segments:

- **Board-only students:** worksheet questions match board mark weightage and answer format.
- **Test-prep students:** same canonical topic graph, but difficulty is raised and JEE/NEET-style framing is applied.

This avoids maintaining two independent content pipelines.

---

## 4. Recommended Tags

```json
{
  "canonical_topic": "quadratic_equations",
  "boards": ["cbse", "msbshse", "kseab", "dge_tn", "upmsp"],
  "exam_track": ["board", "jee_foundation", "neet_foundation"],
  "difficulty_ceiling": 5,
  "proof_level": "proof",
  "answer_format": ["mcq", "short", "long"]
}
```
