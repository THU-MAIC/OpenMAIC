# ADR-004 — Dr. Math B2B2C Pricing & Packaging

**Status:** Proposed  
**Date:** 2026-06-04  
**Author:** Research Agent Synthesis  
**Related:** `docs/research/research-report-004-indian-edtech-market-2026.md`, `docs/research/research-report-005-dpdp-jee-omr-deep-dive.md`

---

## Context

Research Report 004 found that India’s EdTech sector has corrected from a $22 Bn valuation bubble to a sustainable $3–3.6 Bn market. The B2C channel is consolidating around PhysicsWallah and upGrad-Unacademy; the **larger, underpenetrated opportunity is institutional** — tuition centres and budget private schools.

This ADR records the decision on how Dr. Math will price, package, and sell its AI worksheet + OMR + adaptive loop in India.

---

## Decision

We will pursue a **B2B2C land-and-expand model** with the following properties:

1. **Primary buyer:** Tuition centres and coaching chains (faster sales cycle, immediate worksheet need, low switching cost).
2. **Secondary buyer:** Budget private schools and one anchor school (Natalmanjaya High School) for credibility and outcome proof.
3. **Pricing metric:** Per-student-per-month, with annual billing and a low-friction free tier.
4. **Value proposition:** Reduce teacher grading/prep load, give parents progress proof, and close the paper-digital gap via OMR scanning.
5. **Compliance as a feature:** DPDP-ready data practices (India hosting, consent, minimization, erasure) are part of the sales narrative.

### Pricing Tiers (MVP)

| Tier | Monthly Price | Target | Includes |
|------|---------------|--------|----------|
| **Starter** | Free | Individual tutors / pilots | Up to 50 students, 2 worksheets/month, PDF only |
| **Growth** | ₹2,499–4,999/mo | Tuition centres / small schools | Unlimited students, OMR scan, adaptive next worksheet, analytics |
| **Enterprise** | Custom | Multi-branch chains / school groups | White-label, API access, multi-branch dashboards, priority support |

Per-student anchor pricing:
- Tuition centres: **₹50–150 / student / month**.
- Schools: **₹10–50 / student / month** as an add-on to existing ERP/LMS.

### Go-to-Market Motion

1. **Reference customers:** Natalmanjaya High School + 2–3 local tuition centres.
2. **Organic acquisition:** Teacher/principal referrals, Hindi YouTube shorts, local education fairs.
3. **Partnerships:** Export/import integrations with Classplus/Teachmint; later API partnerships with school OS providers.
4. **Outcome proof:** Publish anonymized before/after case studies with consent.

---

## Consequences

### Positive

- Avoids the high-CAC B2C war that destroyed BYJU’S unit economics [R4].
- Tuition centres provide rapid feedback loops for product iteration.
- Per-student pricing aligns revenue with customer growth.
- Institutional contracts are more durable and predictable than individual subscriptions.
- DPDP compliance reduces regulatory risk and builds parent trust [R5].

### Negative / Trade-offs

- Lower ARPU than premium B2C test-prep courses.
- Requires local sales/support capacity as we scale beyond the pilot city.
- Schools have longer procurement cycles; tuition centres must succeed first.
- Free tier needs clear conversion triggers to avoid perpetual free usage.

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Premium B2C app at ₹500+/month | Unaffordable for mass market; high CAC; dominated by PhysicsWallah [R4]. |
| Sell directly to large school chains | 6–12 month sales cycle; no outcome proof yet [R4]. |
| One-time perpetual license | Recurring revenue is lower; misses SaaS valuation and update cadence. |
| Ads or data monetization | Banned/restricted for minors under DPDP; conflicts with trust positioning [R5]. |

---

## Unit-Economics Targets

| Metric | Target | Rationale |
|--------|--------|-----------|
| Gross margin | >70 % | Software-heavy; paper is customer’s cost |
| CAC payback | <6 months | Aligns with annual fee cycle |
| Annual churn | <15 % | Stickiness via adaptive history + OMR data |
| NRR | >110 % | Expansion via more grades/subjects/branches |

---

## Implementation Sketch

```
┌─────────────────────────────────────────────────────────────┐
│  LAND                                                       │
│  • Free pilot for one grade / one month                     │
│  • Teacher onboarding: print → scan → review dashboard      │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  EXPAND                                                     │
│  • Add more subjects / grades                               │
│  • Add parent WhatsApp/Email reports                        │
│  • Offer annual plan with 2 months free                     │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  SCALE                                                      │
│  • Multi-branch dashboards                                  │
│  • White-label app for large chains                         │
│  • API integrations with coaching management tools          │
└─────────────────────────────────────────────────────────────┘
```

---

## References

- [R4] `docs/research/research-report-004-indian-edtech-market-2026.md`
- [R5] `docs/research/research-report-005-dpdp-jee-omr-deep-dive.md`
