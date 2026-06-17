# DFS-003 — Data Sources, Licensing & Governance

**Date:** 2026-06-04  
**Research Phase:** DFS — deep-dive into syllabus data provenance and technical acquisition

---

## 1. Official Data Channels

| Board | Official Syllabus URL Pattern | Format | Update Frequency |
|-------|------------------------------|--------|------------------|
| CBSE | `cbseacademic.nic.in/web_material/CurriculumMain25/` | PDF | Annual |
| MSBSHSE | `mahahsscboard.in → Subjects & Syllabus` | PDF | Annual |
| KSEAB | `kseab.karnataka.gov.in → Documents → SSLC` | PDF | Annual |
| DGE TN | `dge.tn.gov.in/docs/examina/SSLC_E.pdf` | PDF | Annual |
| UPMSP | `upmsp.edu.in → Syllabus 2025–26` | PDF | Annual |
| BSEB | `biharboardonline.bihar.gov.in` | PDF/Notice | Annual |

---

## 2. Third-Party Aggregators

Aggregator sites (Vedantu, Aakash, Allen, CollegeDekho, Padasalai, Physics Wallah Store) reproduce board syllabi with varying accuracy. They are useful for **cross-verification** but should not be the canonical source for product logic.

**Risks:**
- Outdated or reduced-syllabus not applied.
- Mark weightage may be rounded or misattributed.
- Regional-language versions may not match official SCERT books.

---

## 3. Machine-Readability Gap

- **No official JSON/XML/API** for Indian board syllabi was found.
- PDFs are often scanned/image-based or structured tables without tags.
- **Recommendation:** maintain an internal `curriculum-graph` YAML/JSON derived from official PDFs, with manual annual audits.

---

## 4. Legal / Copyright Posture

- **Syllabus facts** (chapter names, mark distribution) are generally public information and not copyrightable.
- **Official textbooks (NCERT/SCERT)** are government publications; short excerpts for educational use usually fall under fair dealing, but full reproduction is not advised.
- **Do not** scrape official portals aggressively; cache PDF metadata and links, not the PDFs themselves, unless licensed.
- **DPDP Act 2023** applies once student PII enters the system; syllabus data itself is not PII, but per-student board/grade/medium preferences are.

---

## 5. Proposed `curriculum-graph` Schema

```yaml
boards:
  - id: cbse
    name: Central Board of Secondary Education
    subjects:
      - id: math_10
        name: Mathematics
        units:
          - id: algebra
            topics:
              - id: polynomials
                name: Polynomials
                marks: null
                prerequisites: [real_numbers]
                excluded: false
                proof_level: state_without_proof
                mediums: [en, hi]
```

This schema lets Dr. Math generate board-aware prompts without hard-coding entire syllabi in prompts.
