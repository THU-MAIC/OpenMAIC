# BFS-005 — Regulatory & OMR Landscape

**Date:** 2026-06-04  
**Research Phase:** BFS — breadth-first scan of DPDP rules, JEE/CBSE sources, and OMR tooling

---

## 1. DPDP Act 2023 — Key Provisions

| Provision | Implication for EdTech |
|-----------|------------------------|
| **Consent-first processing** | Explicit, informed, specific, revocable consent required; pre-existing consent must be notified.[^23] |
| **Children’s data** | Verifiable parental consent mandatory for under-18s; no behavioral tracking or targeted ads.[^23][^24] |
| **Data minimization** | Collect only data necessary for stated educational purpose.[^23] |
| **Purpose limitation & storage limitation** | Use data only for the consented purpose; erase when purpose ends.[^23] |
| **Data Protection Board** | Oversees compliance, grievances, penalties; breach notification required.[^23][^24] |
| **Cross-border transfers** | Allowed only to government-notified jurisdictions; India-hosting is safest.[^23][^25] |
| **Significant Data Fiduciaries** | Large/high-risk processors need DPO, DPIA, audits (status thresholds still evolving).[^23] |
| **Penalties** | Up to ₹250 crore for security failures; ₹200 crore for children’s data / breach-notification violations.[^23][^24] |
| **22 Indian languages** | Notices may need to be provided in Indian languages, not just English.[^26] |

---

## 2. JEE / CBSE Syllabus Sources

| Exam | Official Portal | Math Focus Areas |
|------|-----------------|------------------|
| JEE Main 2026 | jeemain.nta.nic.in | Sets, Relations, Complex Numbers, Matrices, Calculus, Coordinate Geometry, Vectors, 3D, Probability.[^27] |
| JEE Advanced 2026 | jeeadv.ac.in | Algebra, Calculus, Coordinate Geometry, Trigonometry, Vectors, Probability; ~30–35 % Calculus.[^28][^29] |
| CBSE Class 10 | cbseacademic.nic.in | Number Systems, Algebra, Geometry, Trigonometry, Mensuration, Statistics. |
| CBSE Class 11–12 | cbseacademic.nic.in | Sets/Functions, Calculus, Vectors, 3D, Probability, Linear Programming. |

---

## 3. OMR Ecosystem

| Tool / Source | Type | Notes |
|---------------|------|-------|
| **OMRChecker (Udayraj123)** | Open-source Python/OpenCV | MIT license; reads scanned/phone images at any angle; template-driven.[^30] |
| **OpenCV + contour detection** | DIY pipeline | Common academic approach; requires good lighting and markers.[^31] |
| **Ginger Webs Verificare / ThinkExam** | Commercial OMR suite | Enterprise perpetual licenses; high-volume scanning. |
| **Board OMR sheets** | Printed templates | CBSE/Bihar/Kerala use 4 or 5 option bubbles, roll number bubbles, barcodes.[^32][^33] |

---

## 4. Strategic Takeaways

1. DPDP compliance is a **product design constraint**, not just a legal checkbox; build consent, minimization, and erasure into the data model from day one.
2. JEE/CBSE dependency mapping is the **long-term retention driver** for high-aspiration students; board-only mapping is not enough.
3. OMR scanning should start with **server-side OpenCV** (OMRChecker-style) rather than building from scratch or buying expensive commercial licenses.
