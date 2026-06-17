# DFS-003 - Pilot Metric Build Playbook

**Date:** 2026-06-16  
**Scope:** Research-backed execution plan for all pilot metrics in `docs/architecture/thijs-website/pilot-component-checklist.md`.  
**Research Phase:** DFS (deep implementation strategy)

## Objective

Build each website component so it reliably drives action for institutional buyers while reducing perceived risk and effort. Buyers should quickly understand: less admin stress, better decisions, measurable outcomes, and clear next steps.

## Method

- Map each pilot metric C01-C14 to implementation tactics, UX tests, and instrumentation.
- Prioritize canonical sources (W3C/WCAG, web.dev, GA4 docs, NN/g, Baymard, GOV design system).
- Treat C-level targets as launch gates, not aspirational KPIs.

## Component-by-Component Build Plan

### C01 - Sticky Navigation + Top CTA

**Target:** Nav CTA CTR >= 4%, mobile menu error rate < 1%.  
**Build plan:**
1. Keep header compact and persistent; one primary CTA only (`Book a 14-day pilot`).
2. Ensure skip link + keyboard navigation + visible focus + logical tab order.
3. Preserve UTM params into lead form/session attribution.
4. Highlight active section on scroll to reduce orientation friction.
**Measure:** `cta_click` with `cta_id=nav_book_pilot`; menu open/close error events.

### C02 - Hero

**Target:** Hero CTA CTR >= 6%, hero bounce < 45%.  
**Build plan:**
1. Use one stress-relief headline and one operational proof subheadline.
2. Keep primary CTA above fold; add secondary low-commitment CTA (`See workflow`).
3. Use real classroom image and visible continuation cue below fold.
4. Protect LCP element (hero media) from lazy-loading and layout shift.
**Measure:** `cta_click` hero IDs, section dwell, bounce/engaged sessions.

### C03 - Workflow Stepper

**Target:** >= 60% full-scroll on section, >= 20% next action from section viewers.  
**Build plan:**
1. Keep exactly 4 steps; each step states one pain removed.
2. Mobile uses vertical timeline with strong visual order.
3. Add optional demo trigger (GIF/video) with no layout shift.
4. Respect reduced motion settings for all animated transitions.
**Measure:** `section_view` per step, `cta_click` from workflow section.

### C04 - Outcomes Metrics

**Target:** Case-study download >= 2.5% of sessions, claims trust >= 70%.  
**Build plan:**
1. Show only sourced metrics with pilot IDs.
2. Pair each number with plain-language implication (time, performance, risk).
3. Provide downloadable case study and citation links.
4. Keep metric cards visually stable and readable on mobile.
**Measure:** `file_download`/`cta_click` for case-study, interview trust score log.

### C05 - Testimonials

**Target:** >= 15% trust-action click from viewers, relatability >= 4/5.  
**Build plan:**
1. Include one teacher, one principal, one student/parent voice.
2. Use outcome-specific quotes (problem -> result), not generic praise.
3. Ensure attribution + consent metadata is documented.
4. Carousel controls must be keyboard accessible with pause controls.
**Measure:** trust-action CTA clicks from testimonial section.

### C06 - Persona Deck

**Target:** Persona CTA CTR >= 3%, path comprehension <= 10s.  
**Build plan:**
1. Principal card: ROI + execution; Teacher card: workload + control; Parent card: visibility + care.
2. Use `Outcome -> Benefit` copy structure on every bullet.
3. Provide one contextual CTA per persona card.
4. Keep optional privacy/compliance path visible for institutional buyers.
**Measure:** persona CTA events by persona label; rapid comprehension usability test.

### C07 - Product Anatomy + Safeguards

**Target:** Security brief requests >= 1% sessions; privacy objections decrease over baseline.  
**Build plan:**
1. Diagram must include worksheet generator, OMR pipeline, adaptive engine, teacher override.
2. Accordion topics: Security/Privacy, Reliability, Adaptive explainability.
3. Publish plain-language fallback workflow for scan failures.
4. Offer low-friction security brief request flow.
**Measure:** `cta_click` (`anatomy_request_security_brief`) + sales objection logs.

### C08 - Pricing + Packaging

**Target:** Pricing CTA CTR >= 4%, pricing-path form completion >= 30%.  
**Build plan:**
1. Keep four tiers with clear student scope and onboarding details.
2. Add ROI anchor versus manual grading + legacy OMR tooling.
3. Highlight recommended tier and provide transparent comparison table.
4. Avoid hidden-cost ambiguity; include risk guardrails per tier.
**Measure:** pricing CTA clicks, pricing-originated form starts/submits.

### C09 - Community + Collaboration

**Target:** Collaboration CTA CTR >= 2%, at least 5 qualified inquiries.  
**Build plan:**
1. Keep alumni mission story concise and concrete.
2. Separate collaboration actions: contribute worksheets, research, sponsorship.
3. Keep GitHub links and contribution docs directly accessible.
4. Frame funding target (Rs 5.5 lakh) as expansion lever, not pressure message.
**Measure:** collaboration CTA events + qualified inquiry count.

### C10 - End CTA Band

**Target:** End CTA CTR >= 5%, exit reduction >= 10% from section.  
**Build plan:**
1. Use direct time-bound CTA (`Start Pilot in 14 Days`).
2. Add reassurance microcopy (teacher-first onboarding, low risk).
3. Ensure high contrast on gradient and clear button hierarchy.
4. Verify end-to-end flow from CTA click to confirmation page.
**Measure:** CTA band click and downstream completion funnel.

### C11 - Footer

**Target:** >= 1% sessions click research links, zero broken links.  
**Build plan:**
1. Include research references (BFS/DFS/ADR), compliance links, and contact path.
2. Add privacy inquiry channel for IT/compliance evaluators.
3. Run automated broken-link check pre-release.
4. Keep footer labels explicit and non-ambiguous.
**Measure:** footer link click events + synthetic broken-link monitoring.

### C12 - Mobile Sticky CTA + Drawer

**Target:** Mobile CTA CTR >= 0.8x desktop CTA CTR, rage-click < 2%.  
**Build plan:**
1. Sticky CTA respects safe-area and never obscures key controls.
2. Drawer supports keyboard focus management and clear close action.
3. Ensure target sizes meet minimum interaction guidance.
4. Tune motion for reduced-motion users and low-end devices.
**Measure:** mobile CTA clicks, dead/rage-click telemetry, drawer errors.

### C13 - Lead Form / Scheduling

**Target:** Form completion >= 35% from starts, qualified lead rate >= 60%.  
**Build plan:**
1. Keep first-touch form minimal; defer non-critical fields (progressive profiling).
2. Use clear labels, inline + summary errors, and preserve entered data on error.
3. Explain sensitive fields (phone/email usage) with trust microcopy.
4. Confirmation page must state next step and expected response time.
5. Route high-intent leads with short speed-to-contact SLA.
**Measure:** form start/submit/error funnel + qualification tagging.

### C14 - Analytics + Citation Infrastructure

**Target:** 100% primary CTA attribution coverage, zero uncited numeric claims.  
**Build plan:**
1. Implement canonical event taxonomy (`cta_click`, `section_view`, `generate_lead`, `lead_form_error`).
2. Enforce unique `cta_id` and `section_id` on all tracked actions.
3. Capture first-touch + session-touch UTM fields; persist to lead payload.
4. Build dashboard funnel from hero click to qualified lead.
5. Add citation markers/tooltips for all numeric claims.
**Measure:** daily event completeness checks and copy claim audits.

## Rollout Sequence (Best Risk-to-Impact Order)

1. C14 instrumentation and attribution foundation.  
2. C01/C02/C10 conversion-critical surfaces.  
3. C13 lead form reliability and qualification flow.  
4. C03/C04/C05/C06 value communication and trust proof.  
5. C07/C08/C11 risk and procurement confidence layers.  
6. C12 mobile polish and frustration reduction.  
7. C09 collaboration funnel.

## References

- [R1] Nielsen Norman Group. "The Fold Manifesto." https://www.nngroup.com/articles/page-fold-manifesto/  
- [R2] Nielsen Norman Group. "Scrolling and Attention." https://www.nngroup.com/articles/scrolling-and-attention/  
- [R3] Nielsen Norman Group. "Sticky Headers." https://www.nngroup.com/articles/sticky-headers/  
- [R4] Nielsen Norman Group. "Banner Blindness." https://www.nngroup.com/articles/banner-blindness-old-and-new-findings/  
- [R5] web.dev. "Core Web Vitals." https://web.dev/articles/vitals  
- [R6] web.dev. "Optimize LCP." https://web.dev/articles/optimize-lcp  
- [R7] web.dev. "INP." https://web.dev/articles/inp  
- [R8] web.dev. "CLS." https://web.dev/articles/cls  
- [R9] Baymard Institute. "Average Form Fields in Checkout." https://baymard.com/blog/checkout-flow-average-form-fields  
- [R10] Baymard Institute. "Inline Validation." https://baymard.com/blog/inline-form-validation  
- [R11] Baymard Institute. "Adaptive Error Messages." https://baymard.com/blog/adaptive-validation-error-messages  
- [R12] Baymard Institute. "Explain Phone Number Field." https://baymard.com/blog/explain-phone-number-field  
- [R13] Baymard Institute. "Delayed Account Creation." https://baymard.com/blog/delayed-account-creation  
- [R14] Baymard Institute. "Perceived Security in Forms." https://baymard.com/blog/perceived-security-of-payment-form  
- [R15] W3C. "WCAG 2.2." https://www.w3.org/TR/WCAG22/  
- [R16] W3C WAI. "Carousels Tutorial." https://www.w3.org/WAI/tutorials/carousels/  
- [R17] GOV.UK Design System. "Validation Pattern." https://design-system.service.gov.uk/patterns/validation/  
- [R18] Google Analytics. "GA4 Events Reference." https://developers.google.com/analytics/devguides/collection/ga4/reference/events  
- [R19] Google Analytics Help. "UTM Manual Campaign Dimensions." https://support.google.com/analytics/answer/11242870  
- [R20] Segment Docs. "Track Spec." https://segment.com/docs/connections/spec/track/  
- [R21] Microsoft Clarity Docs. "Semantic Metrics." https://learn.microsoft.com/en-us/clarity/insights/semantic-metrics  
- [R22] Optimizely Support. "How Long to Run an Experiment." https://support.optimizely.com/hc/en-us/articles/4410283969165-How-long-to-run-an-experiment
