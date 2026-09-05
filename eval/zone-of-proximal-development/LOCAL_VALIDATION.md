# 习题课（最近发展区）：local validation summary

## Scope and environment

- Date: 2026-09-05. Skill version: `0.2.0-experimental`.
- Model used for the local classroom workflow: `deepseek:deepseek-v4-flash`.
- Classroom checks used an existing local OpenMAIC runtime at `89268e5`, which includes the thinking-context fix `d5fca17` and an unrelated Feynman documentation commit. Neither change is included in this skill PR.
- The PR branch starts from upstream `1e10f60`. The automated checks below were rerun there; the complete model-driven classroom workflow was **not** rerun on that clean runtime baseline.
- All learner responses were constructed by the tester. Generated pages were inspected and locally corrected before the checks passed. This is not evidence of first-pass generation reliability or learning effectiveness.
- The Chinese display name was finalized as **习题课（最近发展区）** after the classroom run. Its unchanged invocation id and new display title are checked by the discovery regression test.

## Observed classroom behavior

The existing three-activity exercise cycle was extended to six teaching pages without recreating the original diagnostic, supported-practice, or independent-check activities:

| Function | Material | Observed result |
| --- | --- | --- |
| Goal and route selection | Explain the goal and how to choose pages | Corrected the initial linear route into explicit conditional choices; reopened and visually checked the saved page |
| Independent diagnosis | `3x + 5 = 20`, free response with a reason | Previous submitted answer, score, and feedback remained available after insertion/reordering |
| Targeted review | Contrast one-sided and two-sided operations on `2a + 6 = 22` | Error explicitly labeled as an illustrative example, not an observed student mistake; mathematics and page rendering checked |
| Optional supported practice | `4x + 3 = 19`; separate worked example `2m + 5 = 11` | Expanded the example, completed the two steps, and obtained the successful substitution check `19 = 19` |
| Fresh independent check | `5x + 4 = 34` and added `2y + 7 = 25` | Two free-response inputs; no solutions or step prompts visible before submission; separate feedback and analysis after submission |
| Reflection and next step | Initial attempt / help used / new-task performance / next step | Visible summary and manual record prompts; corrected a page-number typo and rechecked the saved page |

Both routes were exercised: diagnosis → independent check (skipping review/help), and review → supported practice. Navigation is learner/teacher-selected, not an automatic branching algorithm. Close the page-directory thumbnails during independent work so review material is not displayed beside the questions.

For the two-question submission, the simulated responses included `x = 6` and `y = 9`, with transformation reasons and substitution checks. The first explicitly stated that its solution had already been seen. The report returned 20/20 and separate comments; the first comment also said this was not independent completion and could not establish mastery. After closing the tab completely and reopening the classroom, both responses, scores, comments, and analyses remained available.

## Checks rerun on the isolated PR branch

- Skill frontmatter/name validation: passed.
- `pnpm exec vitest run tests/agent-runtime/skills.test.ts tests/agent-runtime/skill-preload.test.ts tests/agent-runtime/skills-route.test.ts tests/agent-runtime/zpd-skill-discovery.test.ts`: **133 tests passed in 4 files**.
- `pnpm check`: passed. The repository's normal Prettier configuration excludes Markdown; this is not a Markdown-content validation claim.
- `pnpm lint`: passed with 0 errors and 18 warnings in unchanged upstream files; the new discovery test passed its focused lint check without warnings.
- `pnpm exec tsc --noEmit --incremental false`: passed after linking the existing, lockfile-matched workspace dependency installation into the isolated worktree.
- Node engine contract and i18n key alignment checks: passed.

These checks verify loading/integration and repository consistency, not instructional quality or learner-state persistence by themselves. The new test checks the actual discovered id, Chinese title, built-in source, and presence of both supporting references; it does not grade generated prose by keyword matching.

## Limitations and coverage boundaries

- The generated help page explicitly states that its temporary inputs do not survive a full document reload. It is not a cross-page learner record store; the lesson asks learners to retain their reflection separately.
- Adding a question to an already-completed quiz temporarily displayed the old score against the new maximum (10/20). Starting a new attempt produced the two-question report above. Do not interpret the intermediate percentage as a decline in learning.
- Non-mathematical transfer (claim–evidence–reasoning writing) received an independent instruction-level forward check, not a second model-generated classroom run. Revised dialogue rules also need broader future coverage; earlier dialogue tests are not relabeled as final-version passes.
- The skill does not measure a stable ZPD score, establish durable mastery, or turn static optional help into automatic adaptive instruction.
- TTS is explicitly outside this validation scope, not an outstanding acceptance gate.
- No real-student learning outcome study was performed. Local session links, machine paths, credentials, and private learner data are not included in this public summary.
