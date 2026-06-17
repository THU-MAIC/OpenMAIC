# DFS Research — AI Tutoring vs. Human Instruction: The Harvard PS2 RCT

**Research method:** Depth-first investigation of the strongest empirical claim in the seminar: that an AI tutor outperformed a high-quality active-learning classroom.  
**Anchor source:** Kestin, G., Miller, K., Klales, A., Milbourne, T., & Ponti, G. (2025). “AI tutoring outperforms in-class active learning: An RCT introducing a novel research-based design in an authentic educational setting.” *Scientific Reports*, 15, 17458 [R1].  
**Status:** Proposed

---

## 1. What the Seminar Claims

The speaker cites a Harvard experiment in which students alternated weekly between an AI tutor and human tutors in a physical sciences course. Students using the AI tutor scored higher on weekly mastery tests and showed increased engagement [S1].

This is used to challenge the assumption that bot tutors cannot match experienced human educators.

---

## 2. The Actual Study Design

### 2.1 Context

- **Course:** Physical Sciences 2 (PS2), Harvard’s largest introductory physics class for life-sciences majors.
- **Semester:** Fall 2023.
- **Sample:** 233 enrolled; 194 eligible and consenting; final analysis on those with complete pre/post tests.
- **Design:** Crossover RCT. Each student experienced both conditions once over two consecutive weeks.
- **IRB:** Harvard IRB23-0797 [R1].

### 2.2 Conditions

| Condition | Format | Content |
|-----------|--------|---------|
| **Active-learning classroom** | In-person, 75 min, instructor-guided, peer instruction, targeted feedback | Identical handout on surface tension / fluid flow |
| **AI tutor (“PS2 Pal”)** | At-home, LLM-based, custom prompts and scaffolds, two-way conversational | Identical handout; pre-recorded intro video |

### 2.3 Outcome measures

- Pre-test and post-test for each lesson.
- Perception scales: engagement, motivation, enjoyment, growth mindset.

---

## 3. Results

### 3.1 Learning gains

- Median pre-test score: **2.75** for both groups.
- AI tutor post-test median: **4.5**.
- In-class post-test median: **3.5**.
- AI tutor produced roughly **2× the learning gains** of the active-learning classroom [R1][R2].
- Effect sizes were large: **0.7–1.3 standard deviations** [R2].

### 3.2 Efficiency

- Median time on task: **49 minutes** (AI) vs. **60 minutes** (in-class).
- No correlation between time spent and post-test score, suggesting adaptive pacing and immediate feedback were the drivers [R2].

### 3.3 Student perceptions

| Scale | AI tutor | In-class |
|-------|----------|----------|
| Engagement | 4.1 | 3.6 |
| Motivation | 3.4 | 3.1 |
| Enjoyment | higher | lower |
| Growth mindset | comparable | comparable |

**83%** of students rated the AI tutor’s explanations as **as good as or better than** their in-class instructors [R2].

---

## 4. Why It Worked (Design, Not Just Raw LLM Power)

The AI tutor was not off-the-shelf ChatGPT. It included [R1][R2]:

1. **Expert-authored scaffolds** — step-by-step reasoning prompts.
2. **Built-in guardrails** to reduce hallucination.
3. **Pre-vetted content** aligned with learning goals.
4. **Pre-recorded contextual videos** to maintain pedagogical coherence.
5. **Personalised feedback** and self-pacing.

This is consistent with the seminar’s broader argument: **the interface and instructional design matter as much as the underlying model**.

---

## 5. Caveats and Limits

| Limit | Implication |
|-------|-------------|
| Single course, single institution (Harvard) | Generalisability to K-12, Global South, or less-resourced settings is unknown. |
| Two-week crossover | Long-term retention and transfer were not measured. |
| Physics for life-sciences | May not generalise to humanities, creative subjects, or procedural skills. |
| Students already highly motivated | Effects may differ for disengaged or struggling learners. |
| AI condition was at-home, in-class was in-person | Some gain may come from individual pacing rather than AI per se. |
| No cost analysis | Scaling such tutors is technically and financially non-trivial. |

---

## 6. Implications for Dr. Math / OpenMAIC

- **AI-generated explanations for worksheets** are a plausible near-term feature, but only if they include expert-authored scaffolds and guardrails.
- **The PS2 tutor was course-specific**, not a generic chatbot. Dr. Math should similarly constrain the AI to a known curriculum taxonomy and validated question bank.
- **Immediate feedback** is the likely active ingredient; the product should aim for short feedback loops (worksheet → scan → next worksheet) rather than static PDFs.
- **Engagement gains** suggest students may prefer AI-supported practice; this supports a tuition-center-first GTM where practice volume is high.

---

## 7. Key Citations

- [R1] Kestin, G. et al. (2025). “AI tutoring outperforms in-class active learning: An RCT introducing a novel research-based design in an authentic educational setting.” *Scientific Reports*, 15, 17458. DOI: 10.1038/s41598-025-97652-6.
- [R2] VictoryXR / Harvard Gazette summaries of the PS2 study, 2024–2025.
- [S1] Seminar transcript — AI tutor vs. human tutor claim.

---

## 8. Open Questions

1. Has any K-12 RCT replicated the PS2 effect in mathematics, especially in India or similar contexts?
2. What is the minimum scaffold design needed to match PS2 outcomes without the same development budget?
3. How does AI-tutor effectiveness vary by student prior knowledge and language proficiency?
