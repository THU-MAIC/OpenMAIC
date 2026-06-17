# Interpolation-005 — Product Requirements from DPDP + JEE + OMR Research

**Date:** 2026-06-04  
**Research Phase:** Interpolation — deriving concrete product requirements

---

## 1. Data Model Requirements

| Entity | Required Fields | DPDP Control |
|--------|-----------------|--------------|
| `Student` | pseudonym_id, board, grade, medium, enrollment_status | Name/phone stored separately with consent record |
| `ConsentRecord` | purpose, timestamp, guardian_contact, withdrawn_at | Append-only log |
| `Worksheet` | board, grade, topic, excluded_topics, answer_key, retention_date | Auto-delete after retention period |
| `Response` | pseudonym_id, worksheet_id, answers, score, metadata | Anonymize after enrollment ends |
| `OMRScan` | worksheet_id, image_path, confidence, graded_answers | Delete image after grading confirmation |

---

## 2. API / Prompt Requirements

- `POST /api/generate-worksheet-pdf` accepts:
  ```json
  {
    "students": [...],
    "topic": "quadratic_equations",
    "board": "cbse",
    "medium": "en",
    "grade": 10,
    "track": "board",
    "excludedTopics": ["constructions"],
    "questionTypes": ["mcq", "short"],
    "questionCount": 15
  }
  ```
- LLM prompt must include a `board_context` block and a list of excluded topics.
- Generated questions are tagged with canonical topic and board compatibility.

---

## 3. OMR Service Requirements

- Run as Python/FastAPI container with OMRChecker-style pipeline.
- Accept template JSON + image; return answers + confidence.
- Expose `/health` and `/grade` endpoints.
- Store images only until grading is confirmed.

---

## 4. Curriculum Graph Requirements

- YAML/JSON file with nodes: `board → grade → subject → unit → topic`.
- Edges: `prerequisites`, `next_topics`, `jee_foundation`, `excluded_for_board`.
- CLI/admin tool to diff against official board PDFs annually.

---

## 5. Onboarding Requirements

- Institution sign-up: DPA acceptance + student roster import.
- Parental consent: bulk consent via institution, or individual OTP for direct sign-ups.
- First-run tutorial for teachers on printing, scanning, and override workflows.
