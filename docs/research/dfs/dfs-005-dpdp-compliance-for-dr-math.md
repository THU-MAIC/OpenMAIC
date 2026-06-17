# DFS-005 — DPDP Compliance for Dr. Math

**Date:** 2026-06-04  
**Research Phase:** DFS — deep-dive into DPDP obligations and product-specific controls

---

## 1. Data Inventory

| Data Element | Personal Data? | Minor? | Purpose | Retention |
|--------------|----------------|--------|---------|-----------|
| Student name | Yes | Yes | Worksheet header, parent report | Duration of enrollment |
| Student roll number | Yes (linkable) | Yes | OMR matching | Duration of enrollment |
| Board / grade / medium | No (preferences) | N/A | Curriculum alignment | Duration of enrollment |
| Worksheet responses | Yes (academic performance) | Yes | Adaptive engine, grading | Duration of enrollment + analytics anonymization |
| Scanned OMR image | Yes (image of student work) | Yes | Grading | 30–90 days post-grading, then delete |
| Parent phone / email | Yes | No | Consent, reports | Duration of enrollment |
| Teacher/principal contact | Yes | No | Account management | Duration of contract |
| Payment / billing data | Yes | No | Invoicing | As per tax law |

---

## 2. Consent Flow

For **B2B via school/tuition centre:**
- Institution acts as data fiduciary or co-fiduciary; Dr. Math processes data on their behalf.
- Institution obtains parental consent under its existing enrollment agreement.
- Dr. Math provides a **Data Processing Addendum (DPA)** specifying purpose, sub-processors, retention, and security.

For **B2C / direct sign-ups:**
- Verifiable parental consent required (e.g., parent email/phone OTP + declaration).
- No data processing until consent is recorded.
- Easy withdrawal mechanism in parent dashboard.

---

## 3. Technical Controls

| Control | Implementation |
|---------|----------------|
| Encryption at rest | AES-256 on database and object storage |
| Encryption in transit | TLS 1.3 |
| Access controls | Role-based; no direct raw access to student images |
| Audit logs | Structured JSON logs (already implemented) |
| Data residency | India region by default (AWS Mumbai / GCP Mumbai / Azure Pune) |
| Pseudonymization | Internal IDs instead of names in analytics/adaptive engine |
| Retention automation | Scheduled jobs to erase/anonymize after purpose ends |
| Breach response | 72-hour notification plan to Board and affected users |

---

## 4. Prohibited Practices

- **No behavioral tracking** of minors for non-educational purposes.
- **No targeted advertising** to students.
- **No sale** of student data.
- **No cross-border transfer** of personal data without government-approved jurisdiction.
- **No mandatory Aadhaar** collection.

---

## 5. Compliance as a Feature

- Publish a **one-page DPDP compliance note** for school principals.
- Offer **on-premise / private-cloud** deployment for large chains wanting full control.
- Make **data-export and deletion** self-serve for institutions.
