# Research Report 003 — Indian State Board Syllabus Mapping

**Status:** Proposed  
**Scope:** Class 10 Mathematics syllabus alignment across CBSE and major Indian state boards, with a view to board-aware worksheet generation.  
**Research method:** BFS competitive/policy scan, DFS syllabus topology and data-source deep dives, bidirectional board-to-competitive alignment, interpolation to multi-board content generation, intrapolation of gaps and risks.  
**Date:** 2026-06-04

---

## 1. Executive Summary

Dr. Math’s adaptive worksheet engine must generate questions that are **board-aligned** without being board-locked. This report maps Class 10 Mathematics syllabi for CBSE, Maharashtra (MSBSHSE), Karnataka (KSEAB), Tamil Nadu (DGE TN), Uttar Pradesh (UPMSP), and Bihar (BSEB) for 2025–26. Core algebra, geometry, trigonometry, and mensuration topics overlap heavily, but **chapter ordering, mark weightage, and prerequisite assumptions differ**. State boards also diverge on proof requirements, construction emphasis, and internal-assessment weight.

**Key finding:** A single canonical topic graph can cover ~80 % of the shared Class 10 math curriculum, with per-board overlays for sequencing, medium-of-instruction, and deleted/reduced topics. The bigger product risk is not syllabus variation but the **absence of machine-readable official syllabi** and the reliance on third-party aggregators.

**Recommended next step:** Build a `curriculum-graph` data model that stores board → grade → subject → unit → topic → prerequisite mappings, and feed it into the LLM prompt as a per-student board context.

---

## 2. Folder Map

| File | Method | Focus |
|------|--------|-------|
| `bfs/bfs-003-state-board-curriculum-landscape.md` | BFS | Breadth scan of six boards, exam patterns, and official sources. |
| `dfs/dfs-003-class-10-math-topology.md` | DFS | Topic dependency graph, overlap matrix, and board-specific deltas. |
| `dfs/dfs-003-data-sources-and-governance.md` | DFS | Official PDF sources, data quality, licensing, and scraping posture. |
| `bidirectional/bidirectional-003-board-to-jee-alignment.md` | Bidirectional | How state-board topics map to JEE/NEET/CBSE competitive core. |
| `interpolation/interpolation-003-multi-board-worksheet-generation.md` | Interpolation | Converting canonical topic graph into board-specific prompts and PDFs. |
| `intrapolation/intrapolation-003-gaps-and-risks.md` | Intrapolation | Internal critique, missing data, and mitigation plan. |
| `../references/bibliography-indian-edtech-and-boards-2026.md` | — | Consolidated sources. |

---

## 3. Core Insight: The 80/20 Syllabus

Across all boards surveyed, the shared Class 10 math backbone is:

1. **Real Numbers / Number System**
2. **Polynomials**
3. **Pair of Linear Equations in Two Variables**
4. **Quadratic Equations**
5. **Arithmetic Progression**
6. **Coordinate Geometry**
7. **Triangles / Similarity**
8. **Circles**
9. **Constructions**
10. **Introduction to Trigonometry**
11. **Heights & Distances**
12. **Areas Related to Circles**
13. **Surface Areas & Volumes**
14. **Statistics**
15. **Probability**

Boards differ on **which sub-topics are proved, which are stated without proof, whether geometric constructions are examined, and the relative marks assigned**. A canonical model plus board-specific overlays is therefore more maintainable than six independent syllabi.

---

## 4. Product Implications

- **Prompt engineering:** prepend a `board_context` block to worksheet-generation prompts (board, medium, current unit, reduced-syllabus exclusions, expected answer format).  
- **Question bank tagging:** tag every generated question with `canonical_topic`, `boards`, `difficulty`, `marks_type`, and `prerequisite_topics`.  
- **Adaptive path:** use the canonical dependency graph for mastery sequencing; use board overlays only for final output formatting and excluded topics.  
- **OMR templates:** board-specific template variants may be needed for mark allocation (e.g., UPMSP 70/30 vs CBSE 80/20).  
- **Compliance:** do not cache or redistribute official PDFs; link out to official board portals and parse only public facts.
