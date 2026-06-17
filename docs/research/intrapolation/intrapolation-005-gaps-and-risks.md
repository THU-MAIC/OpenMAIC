# Intrapolation-005 — Gaps, Risks & Internal Critique

**Date:** 2026-06-04  
**Research Phase:** Intrapolation — internal critique of the DPDP/JEE/OMR research

---

## 1. DPDP Gaps

- **Rules 2025 are new:** thresholds for Significant Data Fiduciaries and the full list of approved cross-border jurisdictions are still evolving.
- **No legal review:** This research is product-oriented, not a substitute for counsel.
- **Vernacular consent:** Translating notices into 22 languages at scale is non-trivial; start with English + Hindi.

## 2. JEE/CBSE Mapping Gaps

- We did not download official NTA/CBSE PDFs; topic lists are from aggregator summaries.
- No primary student-performance data to validate prerequisite weights.
- Class 9 and state-board Class 11–12 mappings were not covered.

## 3. OMR Gaps

- OMRChecker was not benchmarked on our target phone-camera images.
- No data on real-world accuracy for low-cost printers or crumpled sheets.
- Board-specific OMR templates (e.g., Bihar 100-question sheet, Kerala 5-option sheet) were only surveyed, not standardized.

## 4. Product Risks

| Risk | Mitigation |
|------|------------|
| DPDP penalties | Legal review, minimal data, India hosting |
| Wrong prerequisite graph | Start with expert-curated graph; validate with pilot data |
| OMR accuracy fails in field | Confidence thresholds + teacher override + manual fallback |
| JEE content too hard too early | Use `track` parameter to gate difficulty ceiling |

## 5. Recommended Next Steps

1. Engage a privacy lawyer to review DPA and consent flow.
2. Download official NTA/CBSE syllabi for Class 10–12.
3. Build a proof-of-concept OMR pipeline using OMRChecker on sample phone scans.
4. Pilot the board-context prompt with CBSE Class 10 Maths before adding state boards.
