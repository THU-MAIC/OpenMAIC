# DFS-005 — OMR Pipeline & Template Design

**Date:** 2026-06-04  
**Research Phase:** DFS — deep-dive into OMR sheet layout and scanning pipeline

---

## 1. Standard OMR Fields (Indian Boards)

| Field | Format | Notes |
|-------|--------|-------|
| Roll number | 6–8 digit bubbled grid | Each digit 0–9; must be filled for matching.[^32] |
| Subject code | 3-digit bubbled grid | CBSE uses 3-digit codes (e.g., 041 Math Standard). |
| Set / version | A/B/C/D or 1/2/3/4 bubble | For question-paper variants. |
| Medium | English/Hindi/Regional bubble | Some boards ask medium of answering. |
| Date / exam centre | Optional bubbles | For high-stakes board exams; not needed for practice worksheets. |
| Answer grid | 4-option (A–D) or 5-option (A–E) | CBSE typically 4 options; Kerala KEAM uses 5.[^32][^33] |
| Barcode / QR code | Machine-readable | Links to worksheet ID; protects against mismatched sheets. |

---

## 2. Recommended Dr. Math Practice Template

For a **20–30 MCQ practice worksheet**, the OMR strip should include:

1. **Worksheet ID QR code** (top-left) — links to metadata: topic, answer key, student ID.
2. **Student ID bubbles** — 6 digits; optional if QR already encodes student ID.
3. **Question numbers 1–N** with 4 bubbles each (A–D).
4. **No negative-marking bubbles** unless requested.
5. **Corner markers** for automatic alignment.

**Design constraints:**
- Bubble size: ~12–14 mm diameter on A4.
- Minimum spacing: ~4 mm between bubbles.
- Use black/blue ballpoint pen (specify in instructions).
- Include a "rough work" box to discourage stray marks near bubbles.

---

## 3. Scanning Pipeline (Server-Side OpenCV)

```
Mobile camera image
    ↓
Pre-processing (grayscale, blur, threshold)
    ↓
Detect corner markers / page contours
    ↓
Perspective transform to top-down view
    ↓
Locate bubbles by grid geometry
    ↓
For each bubble: measure fill ratio
    ↓
Apply confidence threshold (e.g., 0.6)
    ↓
Output: {studentId, answers[], confidence[], flagged[]}
```

---

## 4. Open-Source Starting Point

**OMRChecker** (MIT license, Python/OpenCV) supports:
- Template-driven layout via JSON.
- Any-angle scanned images.
- Multiple question types (MCQ, integer, etc.).
- Annotated output images for verification.[^30]

**Integration option:** run OMRChecker as a Python microservice; Next.js API sends image and template; service returns JSON.

---

## 5. Accuracy Mitigations

| Problem | Mitigation |
|---------|------------|
| Poor lighting / shadows | Guide user with on-screen overlay; reject low-contrast images |
| Skewed camera angle | Corner markers + perspective correction |
| Partially filled bubbles | Confidence threshold + teacher override |
| Stray marks / multiple bubbles | Flag for manual review; do not auto-score ambiguous rows |
| Low-resolution scans | Minimum 200 DPI / 1080p short edge |
| Ink bleeding | Recommend ballpoint pen; avoid gel pens |

---

## 6. Fallback UX

- If confidence < threshold, show annotated image to teacher for manual correction.
- Allow teacher to type answers directly from the app.
- Store original image only until grading is confirmed; then delete or archive per retention policy.
