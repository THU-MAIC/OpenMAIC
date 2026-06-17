# BFS Research — Generative AI in Education: Landscape Mapping

**Research method:** Breadth-first scan of the GenAI-in-education ecosystem, using the Bharat Anand Harvard seminar as the anchor case.  
**Time horizon:** 2024–2026 (real-time/current sources where available).  
**Status:** Proposed

---

## 1. Anchor Event: What We Are Mapping

The seminar transcript under analysis was delivered by **Bharat N. Anand**, then Vice Provost for Advances in Learning at Harvard University and Henry R. Byers Professor at Harvard Business School. Anand joined the HBS faculty in 1998, served 27 years at Harvard, chaired Harvard’s **Generative AI Working Group for Teaching and Learning**, helped launch **HBS Online**, and co-created the **Axim Collaborative** [S1][S2]. The talk applies the framework from his November 2024 *Harvard Business Review* article, *“The Gen AI Playbook for Organizations”* [S3].

Identifying the speaker matters because the seminar is not an abstract tech forecast; it is an institutional strategy talk from someone who has overseen Harvard’s residential, online, and pandemic-era teaching operations.

---

## 2. Macro Landscape: Adoption Speed and Expectations

### 2.1 Technology penetration curves

The seminar opens with a comparison of how long technologies took to reach 50% US economic penetration [S4]:

| Technology | Time to 50% penetration |
|------------|-------------------------|
| Radio | ~20 years |
| TV | ~12 years |
| Smartphones | ~7 years |
| Smart speakers | ~4 years |
| AI chatbots | ~2.5 years |

The takeaway: GenAI is spreading faster than any previous general-purpose technology. This justifies urgency, but it also invites the classic hype-cycle mistake of overestimating short-term impact while underestimating long-term structural change.

### 2.2 Higher-ed AI adoption in practice

A 2024 Harvard undergraduate survey (n=273) found [R1]:

- **87.5%** of students use generative AI.
- **>95%** of those use ChatGPT.
- ~**30%** pay for premium subscriptions, and paid users get disproportionately more value (less use of Google/Wikipedia, less need for office hours).
- **Lower-income students are significantly less likely to pay** for AI tools, an early inequality signal.

At the faculty level, Harvard’s secure AI sandbox had **30–35% adoption** among faculty versus only **~5%** among students on the official platform; students prefer private accounts for privacy reasons [S5].

This split—students ahead on usage, faculty ahead on institutional governance—shapes how universities must design policy.

### 2.3 Policy and framework landscape

| Framework | Author | Core stance | Relevance to seminar |
|-----------|--------|-------------|----------------------|
| **OECD AI Principles (2019) + 2023/2024 education guidance** | OECD | Trustworthy, transparent, inclusive; equity and teacher capacity [P1] | Supports the seminar’s call for human-in-the-loop, task-level adoption decisions. |
| **UNESCO Guidance for Generative AI in Education and Research (2023/2024)** | UNESCO | Human-centred, protect agency, build teacher capacity, promote inclusion and linguistic diversity [P2] | Directly echoes Anand’s emphasis on teacher role redefinition and empathy. |
| **UNESCO AI Competency Frameworks for Teachers/Students (2024)** | UNESCO | AI literacy as a prerequisite for equitable use [P3] | Explains why “access” is not enough; users need fluency. |
| **EU Ethical Guidelines on AI and Data in Education (2022, rev. 2026)** | European Commission | Teacher agency, data ethics, transparency [P4] | Reinforces high-cost-of-error guardrails. |

The seminar’s argument—that AI is a strategic investment, not just an expense—mirrors OECD and UNESCO language about **human-centric** integration rather than wholesale automation [P1][P2].

---

## 3. Player Map: Who Is Doing What

| Category | Example | Role in the ecosystem |
|----------|---------|----------------------|
| **Institutional strategist** | Bharat Anand / Harvard VPAL | Frames governance, working groups, task-level adoption matrices. |
| **Course-level innovator** | Greg Kestin & Kelly Miller / Harvard PS2 | Builds course-specific AI tutors and runs RCTs. |
| **Platform enabler** | Axim Collaborative (Harvard+MIT) | Uses edX proceeds to focus on degree completion for underserved learners. |
| **Commercial tutor** | Khanmigo, Duolingo Max, HoloTutor | Scales conversational AI tutoring, often with guardrails. |
| **Policy referee** | UNESCO / OECD / EU | Sets guardrails around agency, equity, data. |
| **Critic / watchdog** | Class Central, academic researchers | Tracks completion rates, digital-divide effects, and assessment integrity. |

Key insight: The seminar sits at the **institutional-strategist** layer. Its recommendations are most useful for deans, provosts, and school leaders who must decide where AI is allowed, where it is mandatory, and where it is banned.

---

## 4. Gaps in the Landscape

1. **Middle-income and Global South K-12 institutions** are under-represented in both the seminar and the policy frameworks; most evidence is from elite US higher ed.
2. **Real-time measurement** of AI’s impact on learning outcomes is sparse; the PS2 RCT is one of the few rigorous examples.
3. **Assessment redesign** lags behind AI tool proliferation; many institutions still rely on take-home essays that AI can complete.
4. **Cost-of-error tooling** is mostly conceptual; few universities have operational rubrics for task-level AI approvals.

---

## 5. Implications for Dr. Math / OpenMAIC

- The seminar’s **task-level, cost-of-error lens** is directly transferable to worksheet generation: some tasks (worksheet formatting, question-variant generation) are low-cost-of-error; others (grading high-stakes exams, diagnosing misconceptions) are high-cost and need human review.
- The **access-versus-fluency tension** warns against assuming that cheaper AI worksheets alone will close learning gaps; prompt literacy and teacher support matter as much as access.
- **Policy frameworks** (UNESCO/OECD) can be used as citation anchors for any AGENTS.md or ADR that governs AI use in the product.

---

## References

- [S1] Bharat Anand biography — Concurrences, NYU Stern, ASU GSV Summit.
- [S2] Harvard Gazette, “Exploring potential benefits, pitfalls of generative AI,” 3 Apr 2024.
- [S3] Anand, B. “The Gen AI Playbook for Organizations,” *Harvard Business Review*, Nov 2024.
- [S4] Seminar transcript (source provided by user) — technology-penetration comparison.
- [S5] Seminar transcript — faculty/student adoption rates.
- [R1] Hirabayashi, S. et al. “Harvard Undergraduate Survey on Generative AI,” arXiv:2406.00833, 2024.
- [P1] OECD. “AI Principles” (2019) and “Opportunities, Guidelines and Guardrails on Effective and Equitable Use of AI in Education” (2023/2024).
- [P2] UNESCO. “Guidance for Generative AI in Education and Research” (2023/2024).
- [P3] UNESCO. “AI Competency Framework for Teachers” and “AI Competency Framework for Students” (2024).
- [P4] European Commission. “Ethical Guidelines on the Use of Artificial Intelligence and Data for Teaching and Learning” (2022, revised 2026).
