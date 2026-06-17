# Intrapolation Research — Internal Critique and Gaps in the Seminar

**Research method:** Intrapolation — examining the seminar’s internal consistency, unstated assumptions, and missing dimensions.  
**Status:** Proposed

---

## 1. What Intrapolation Means Here

Where interpolation connects the seminar’s dots, intrapolation looks **inside** the argument to ask:

- What is assumed but not defended?
- What evidence is cited without scrutiny?
- What important dimension is absent?
- Where does the argument contradict itself?

This is not dismissal; it is the research-first 10-persona filter applied to the seminar itself.

---

## 2. Identified Gaps

### 2.1 Elite-institution bias

The seminar is grounded in Harvard’s context: highly selected students, abundant resources, a 27-year teaching-and-learning veteran, and an AI sandbox. The framework is presented as general, but the evidence mostly comes from one of the world’s best-resourced universities [S1].

**Implication for Dr. Math:** The cost-of-error matrix and AI-tutor findings may not transfer directly to Indian state-board schools or budget tuition centres. Local validation is essential.

### 2.2 The “Ryanair principle” may not apply to children

The seminar compares imperfect AI to Ryanair: customers tolerate bad service because it is cheap [S1]. But education is not a discretionary flight; learners are children, parents are paying for outcomes, and errors can compound over years.

**Implication for Dr. Math:** Low-cost-of-error tasks in adult customer service are not the same as low-cost-of-error tasks in K-12. A wrong worksheet answer today can become a misconception tomorrow.

### 2.3 The MOOC parallel is under-specified

The seminar says MOOCs enrolled millions but completion was low and completers were already educated [S1]. This is accurate [R1][R2], but the seminar does not explain why GenAI will avoid the same trap beyond “transformative redesign.”

**Implication for Dr. Math:** Access to AI worksheets must be paired with **accountability structures** (teacher oversight, scheduled practice, parent visibility) that MOOCs lacked.

### 2.4 AI tutor evidence is strong but narrow

The PS2 RCT is rigorous, but it compares an AI tutor to an **in-class active-learning session**, not to a high-quality human tutor or sustained one-on-one instruction [R3]. The seminar’s claim that “bot tutors can match human experts” is slightly stronger than the evidence supports.

**Implication for Dr. Math:** Market the product as “adaptive practice,” not as a replacement for expert human teaching.

### 2.5 Missing dimension: data privacy and child safety

The seminar mentions risks (misinformation, lazy learning, assessment integrity) but does not deeply address:

- Student data ownership.
- FERPA/GDPR/COPPA compliance.
- AI vendors training on student inputs.
- Bias in generated content toward Western or English-centric contexts.

**Implication for Dr. Math:** Build privacy-by-design and PII-free logging from day one, as already started with the worksheet feature.

### 2.6 Missing dimension: teacher labour

The seminar assumes that automating mundane tasks frees teachers for higher-order work. It does not address:

- Whether institutions will invest the saved time in pedagogy or simply cut staffing.
- How teachers are retrained for the new role.
- Who is accountable when AI-generated materials are wrong.

**Implication for Dr. Math:** Position the product as a **teacher-augmentation** tool with clear accountability, not as a cost-cutting replacement.

### 2.7 Contradiction: access vs. fluency

The seminar argues the revolution is about access, but later acknowledges that experts benefit more than novices [S1]. These two claims are in tension: if access were sufficient, gaps would narrow; if fluency is required, gaps may widen.

**Resolution:** Access is necessary but not sufficient. The product must build **AI literacy and prompt scaffolding** into the user experience, especially for less-educated parents and teachers.

---

## 3. A Balanced Reading

The seminar is best read as a **strategic provocation** for well-resourced institutions, not as an implementation manual. Its greatest value is the cost-of-error matrix and the interface-access thesis. Its greatest weakness is the assumption that the same logic applies uniformly across age groups, cultures, and resource levels.

---

## 4. Implications for ADR-001 / Dr. Math

Before accepting the seminar’s recommendations as guidance for OpenMAIC, the ADR should:

1. **Localise the cost-of-error matrix** for Indian K-12 and test-prep contexts.
2. **Validate AI-tutor claims** with small pilots before productising explanations.
3. **Add privacy, bias, and accountability** as first-class design constraints.
4. **Treat access and fluency as twin goals**, not access alone.

---

## 5. Key Citations

- [S1] Seminar transcript — claims and gaps analysed above.
- [R1] Jordan, K. (2014/2015). MOOC completion analyses.
- [R2] IntechOpen chapter (2023). MOOCs and the digital divide.
- [R3] Kestin et al. (2025). PS2 AI tutor RCT — scope and caveats.

---

## 6. Open Questions

1. What would a K-12-specific cost-of-error matrix look like for India?
2. Which seminar claims should be treated as hypotheses requiring local pilots?
3. How can the product explicitly narrow the expert–novice AI benefit gap rather than assume access is enough?
