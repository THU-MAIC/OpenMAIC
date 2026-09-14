# POE inquiry lesson: validation status

## Status

**Local draft; classroom validation not yet performed; not submitted upstream.**

- Date: 2026-09-14. Skill version: `0.1.0-experimental`.
- Base commit: `98765db8b3369247aa4c3ba1e0d957064d234251`.
- Skill and integration changes are confined to content, workbench titles and discovery tests. No application runtime, provider, grading or persistence behavior was changed.
- A separate local environment was installed from the frozen lockfile, with its own empty database and classroom directory. Application startup and HTTP responses were checked.
- The configured model is `deepseek:deepseek-v4-flash`; no model-driven classroom run has yet used it for this Skill.

## Completed checks

| Check | Result |
| --- | --- |
| Focused discovery, preload, routes, runner registration and workbench tests | 253 tests passed in 8 files |
| Full root unit suite | 7,944 passed; 79 skipped; 705 passed test files and 9 skipped files |
| Repository formatting | Passed |
| TypeScript | Passed |
| i18n key alignment | Passed |
| ESLint | Passed: 0 errors, 18 warnings in unchanged upstream files |
| Frozen install and normal workspace postinstall | Passed; no tracked package-file changes |
| Independent integration and pedagogical review | Completed; identified design issues addressed |

The first full unit run failed because its sandbox could not open local test listeners, and because an inherited provider environment variable affected existing image-guard expectations. A clean test process without that inherited variable and with local-listener permission passed the full suite above. No product code, test expectations or exclusions were changed to obtain the pass.

These are code/integration checks, not classroom, grading-quality or learning-effect evidence.

## Review changes

- Prediction recording is separated from automatic short-answer grading. The recommended path fills one shared record in two visits, leaving observation and explanation blank until after observing.
- The protocol requires actual verification of draft persistence and disabled submission while later questions remain empty. A draft is editable and page navigation is not a forced sequence.
- Per-question grading context is made explicit: explanation responses must restate the compared prediction and observations, and the grading prompt supplies the necessary material. The grader cannot be assumed to read another question's response.
- Initially matching predictions can be retained or refined; revision is not required merely to manufacture a change of mind.
- The simulation's position formula and explanatory equations are withheld until after the learner's own explanation. Model output is distinguished from independently measured evidence.

## Pending real classroom checks

| Check | Status |
| --- | --- |
| Browser menu discovery and actual Skill loading | NOT_RUN |
| Model-driven page generation and saved-page inspection | NOT_RUN |
| Prediction draft before feedback; submission unavailable while O/E are empty | NOT_RUN |
| Rapid navigation, refresh, close/reopen and draft recovery | NOT_RUN |
| Simulation controls, intermediate values and replay | NOT_RUN |
| Observation/explanation submission and feedback retrieval | NOT_RUN |
| Matching and nonmatching prediction paths | NOT_RUN |
| Learner-authored review and new-condition question | NOT_RUN |
| Method-only request boundary and ordinary classroom regression | NOT_RUN |
| Audio | NOT_RUN |
| Real-student learning outcomes | NOT_STUDIED |

Browser automation could not verify its enforced access policy, including after its connection was reset. No access workaround was used. The classroom protocol remains pending until normal browser access is restored; application startup and automated checks do not substitute for it.

Before upstream submission, replace these pending entries with actual observations and document any generated-content repairs. Do not publish local endpoints, machine paths, session identifiers, credentials or private logs.
