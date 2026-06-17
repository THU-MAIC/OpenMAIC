# Research Report 005 — DPDP 2023, JEE/CBSE Dependency Mapping & OMR Design

**Status:** Proposed  
**Scope:** Deep research on three operational enablers for Dr. Math: (1) India DPDP Act 2023 compliance for student data, (2) JEE/CBSE Class 10–12 mathematics dependency graph, (3) OMR sheet design and scanning technology for Indian board worksheets.  
**Research method:** BFS regulatory/technology scan, DFS on DPDP obligations and OMR pipeline, bidirectional JEE-to-board mapping, interpolation to product requirements, intrapolation of risks.  
**Date:** 2026-06-04

---

## 1. Executive Summary

This report turns the strategic findings of Reports 003 and 004 into **actionable product constraints**:

1. **DPDP Act 2023** is now in force (Rules 2025 operationalize it). Student data is personal data; minors require verifiable parental consent; behavioral tracking and targeted advertising are banned; cross-border transfers are restricted to government-approved jurisdictions; penalties can reach ₹250 crore. Dr. Math must be designed as a **data-light, consent-first, India-hosted** service.

2. **JEE/CBSE dependency mapping** shows a clear staircase: Class 10 algebra/geometry/trigonometry feeds Class 11 sets/functions, coordinate geometry, and introductory calculus, which feeds Class 12 calculus, vectors, and 3D geometry. The adaptive engine should model these **multi-year prerequisites** to serve test-prep students, not just annual board prep.

3. **OMR design** for Indian boards is standardized around roll-number bubbles, subject code, set/version, and 4-option (A–D) or 5-option (A–E) answer grids. Open-source tools like **OMRChecker (Python/OpenCV)** provide a proven starting point; mobile-camera capture requires corner markers, perspective correction, and confidence scoring.

**Key finding:** Dr. Math can satisfy compliance, pedagogy, and operations at the same time by storing minimal PII, hosting in India, using board-standard OMR templates, and modeling a multi-year math prerequisite graph.

---

## 2. Folder Map

| File | Method | Focus |
|------|--------|-------|
| `bfs/bfs-005-regulatory-and-omr-landscape.md` | BFS | DPDP rules, consent patterns, OMR ecosystem, JEE/CBSE syllabus sources. |
| `dfs/dfs-005-dpdp-compliance-for-dr-math.md` | DFS | DPDP obligations, data minimization, consent flow, breach response. |
| `dfs/dfs-005-jee-cbse-math-dependency-graph.md` | DFS | Class 10 → 11 → 12 topic dependencies and JEE weightage. |
| `dfs/dfs-005-omr-pipeline-and-template-design.md` | DFS | OMR template layout, open-source scanners, accuracy mitigations. |
| `bidirectional/bidirectional-005-compliance-to-trust.md` | Bidirectional | How DPDP compliance becomes a sales/trust differentiator. |
| `interpolation/interpolation-005-product-requirements.md` | Interpolation | Product requirements derived from DPDP + JEE + OMR findings. |
| `intrapolation/intrapolation-005-gaps-and-risks.md` | Intrapolation | Internal critique and remaining unknowns. |
| `../references/bibliography-indian-edtech-and-boards-2026.md` | — | Updated consolidated references. |

---

## 3. Top-Level Product Requirements

1. **Consent:** capture verifiable parental consent at student onboarding; record purpose, withdrawal mechanism, and data-retention period.
2. **Data minimization:** store only pseudonymous student IDs and board/grade/medium preferences; avoid Aadhaar, phone numbers of minors, and biometric data unless strictly necessary.
3. **India hosting:** keep personal data and backups within Indian cloud regions by default.
4. **Multi-year graph:** extend the canonical Class 10 graph backward to Class 9 and forward to Class 11–12 for JEE foundation tracks.
5. **OMR template:** support 4-option and 5-option grids, roll number bubbles, subject code, set/version, and a QR code linking to the worksheet metadata.
6. **Fallbacks:** manual answer entry and teacher override when OMR confidence is low.
