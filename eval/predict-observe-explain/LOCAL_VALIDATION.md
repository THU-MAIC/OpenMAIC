# POE inquiry lesson: validation status

## Status

**Bounded local classroom validation completed after documented repairs; experimental Skill.**

- Date: 2026-09-14. Skill version: `0.1.0-experimental`.
- Base commit: `98765db8b3369247aa4c3ba1e0d957064d234251`.
- Initial candidate: `835163e865e1d529c33c34b556694fce47c4153b`. Final tested Skill content: `b820957` (the initial classroom plus the targeted refinements/retests below). Later commits only record validation. This was a guided local run, not an unaided first-generation success.
- Skill and integration changes are confined to content, workbench titles and discovery tests. No application runtime, provider, grading or persistence behavior was changed.
- A separate local environment was installed from the frozen lockfile, with its own empty database and classroom directory. Application startup and HTTP responses were checked.
- The classroom was generated and its short answers were graded using `deepseek:deepseek-v4-flash`.
- All learner responses below are constructed tester inputs, not observations of real students. The falling-balls activity uses a specified ideal model, not independent experimental measurements.

## Completed code and integration checks

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

The full suite and repository checks above were obtained for the candidate before the classroom run. After the text refinements, all 13 POE discovery/title/reference tests and changed-file formatting/diff checks passed again. No application code changed; the full suite was not repeated for the later documentation-only edits.

## Review changes

- Prediction recording is separated from automatic short-answer grading. The recommended path fills one shared record in two visits, leaving observation and explanation blank until after observing.
- Draft persistence and disabled submission while later questions remain empty were exercised in the classroom, as recorded below. A draft is editable and page navigation is not a forced sequence.
- Per-question grading context is made explicit: explanation responses must restate the compared prediction and observations, and the grading prompt supplies the necessary material. The grader cannot be assumed to read another question's response.
- Initially matching predictions can be retained or refined; revision is not required merely to manufacture a change of mind.
- The simulation's position formula and explanatory equations are withheld until after the learner's own explanation. Model output is distinguished from independently measured evidence.

## Real classroom observations

Browser access recovered after the application was restarted. The earlier access-policy failure did not require a workaround and no longer blocks this run.

### Prediction record and observation

The workbench displayed the new Chinese menu title and actually loaded the Skill. All four planned pages were generated, saved and read back: a three-question prediction/observation/explanation record, an interactive observation page, a teacher-synthesis slide, and a two-question review/boundary record. The tester followed the planned route through these pages.

The tester first entered only a prediction that the heavier ball would land first because it experiences greater gravity. The observation and explanation answers remained empty. Submission stayed disabled and no correctness feedback appeared. The complete prediction and reason were recovered after rapid page navigation, a browser refresh, and closing and reopening the lesson.

The observation page showed two balls at 5 m initially. At model time 0.4 s, both height displays read 4.20 m and the screenshot showed matching ball positions. Natural playback ended at 1 s with both at 0 m. Start, pause, continue and replay were operated through the actual interface using keyboard activation of its controls. After replay, the display showed 0.01 s and both heights rounded to 5 m while running.

The table was initially collapsed and was explicitly expanded by the tester. Its six model times, 0/0.2/0.4/0.6/0.8/1.0 s, corresponded to 5/4.8/4.2/3.2/1.8/0 m for both balls. These are outputs of the supplied model, not measured evidence independently validating that model.

### First observation/explanation submission

After observing, the tester returned to the record, preserved the initial prediction, and added the 0.4 s and 1.0 s readings. The explanation restated the original prediction and reason, identified the mismatch with those readings, distinguished force from motion, and explicitly retained uncertainty about the full cause and the limits of a simulation.

Completing all three answers enabled submission. Actual AI grading returned 30/30, 30/30 and 40/40. Prediction feedback explicitly did not deduct points for physical incorrectness; observation feedback addressed the entered times and heights; explanation feedback acknowledged that the initial prediction was unsupported, required revision, and could retain uncertainty. After closing the lesson tab and reopening from the course list, all three original answers and their 30/30, 30/30 and 40/40 feedback were retrieved.

The existing quiz summary nevertheless displayed `100/100` and `3 correct`. In this record those labels reflect the configured expression-focused assessment. They do not establish that the initial physical prediction was correct, that knowledge was mastered, or that learning was effective. This Skill does not change the quiz summary or grading runtime.

### Matching-prediction feedback retry

After recording the first completed route, the tester used the existing retry control on the three-question record. Every relevant response explicitly labelled this as a constructed example after seeing the result, not a fresh prediction or another learner. The hypothetical initial prediction was simultaneous arrival with `a = F/m = g` and identical initial conditions. The explanation cited 0.4 s/4.20 m and 1 s/0 m, retained the explanation, refined its conditions and acknowledged that the model cannot independently prove its assumptions.

Actual feedback returned 30/30, 30/30 and 40/40 and accepted retaining/refining the explanation without requiring a change of mind. This verifies the bounded feedback path only. The retry replaced the current visible attempt; it does not establish an immutable prediction or a complete accessible history. A wholly uncertain initial prediction was not separately submitted in this run.

### Teacher synthesis, review and boundary

The third page presented `F = mg` and `a = F/m = g`, the shared release conditions, absence of air resistance and near-Earth uniform-gravity approximation. It explicitly placed this synthesis after the personal explanation and distinguished model output from independent measurement. The actual rendered page showed the formulas clearly without overflow.

The fourth page contained exactly two short-answer questions: a tester-authored review after the synthesis, followed by a changed-mass question and a question about applying the explanation to paper and a steel ball in air. Each grading prompt independently supplied its conditions, reference material and criteria; the review question expressly allowed an initially matching prediction to be retained. Before answering, neither reference analyses nor grading prompts appeared in the interface, and the visible questions and narration did not reveal the new-condition answers.

The tester submitted two constructed review/boundary responses. Actual grading awarded 20/20 for each and responded to the entered reasoning. After closing the tab and reopening from the course list, both answers and both 20/20 feedback records were recovered. These post-synthesis responses are separate from the initial explanation and are not evidence of independent student learning or a complete immutable attempt history.

### Generated-content repairs and method-only boundary

The first observation page used wording equivalent to “synchronous falling” in its subtitle and “fall together” in an instruction, prematurely describing the result to be observed. It also included an unnecessary automatic `widget_reveal` action for the readings table. The Skill was refined to require neutral observation-page wording. The workbench repair receipt showed exactly two text replacements and deletion of that action, with the calculation unchanged. The saved content was read back, and the actual interface displayed the neutral wording. The table remained initially collapsed and could be expanded using keyboard activation of its button. The initial generation is not counted as free of disclosure.

A separate precision check found that the original generated calculation linearly interpolated a height table sampled every 0.05 s. The six specified readout times were exact, but values between samples approximated `5 - 5t²` with a maximum height error of 0.003125 m. The workbench was asked to replace this with direct formula evaluation. That edit accidentally removed the still-used `T_END` and `H_TOP` declarations; a real interface run showed a blank canvas and a `T_END is not defined` error despite the model claiming the constants remained. A subsequent minimal edit restored both declarations. The final interface was rechecked: 0.37 s showed 4.32 m for both balls (4.3155 m rounded), 0.40 s showed 4.20 m, replay began at 0 s/5 m and naturally ended at 1 s/0 m. Start, pause, slider adjustment and table expansion worked, and the screenshot showed matching positions. The formula remained internal to the observation page. These repairs concern generated lesson content, not application runtime code.

The method-only boundary was tested in three attempts. The first avoided lesson creation and exercises but did not meet the language/comparison requirements. After a first Skill refinement, the second still generalized ordinary quizzes as primarily checking conclusions; the session's actual Skill read contained the new instruction, so this was not an old-file cache result. A separate, explicit method-only paragraph was then added. The third attempt explained POE in Chinese, acknowledged that ordinary quizzes can assess reasoning, require explanations and provide formative feedback, and created neither a classroom nor an exercise. This is a successful bounded retest after two unsatisfactory attempts, not evidence of universal prompt adherence.

### Ordinary quiz and navigation regression

A separate ordinary quiz was requested with one page and one multiple-choice question, `2 + 3`. The model's first draft included two extra questions and was corrected by the model to the requested single question. In the actual interface, the tester selected option B (`5`), submitted, and received 10/10 with the explanation displayed. No POE prediction/observation/explanation sequence was imposed on this quiz. Normal lesson-page navigation was also exercised successfully.

During the wider browser run, content stopped updating while multiple temporary tabs were open. Closing those tabs and continuing with a single tab restored progress. The successful actions above do not establish general browser or multi-tab stability.

### Audio

An actual `list_voices` call returned no available voices and the interface's Mute control was disabled. The lesson was exercised as a prototype without audio. Speech synthesis and audio playback were not tested.

## Check status

| Check | Status |
| --- | --- |
| Browser menu discovery and actual Skill loading | PASSED in the tested workbench |
| Model-driven generation and saved-page inspection | PASSED for all four pages, including documented content repairs |
| Prediction draft before feedback; submission unavailable while O/E are empty | PASSED |
| Rapid navigation, refresh, close/reopen and draft recovery | PASSED for the initial prediction |
| Simulation controls, intermediate values, replay and expanded table | PASSED; affected controls and values rechecked after the final calculation repair |
| Direct-formula calculation repair and interface recheck | PASSED after fixing an intermediate missing-constant failure; 0.37 s, 0.40 s, replay/end and table checked |
| Observation-page disclosure repair | PASSED: two text replacements and one action deletion read back and checked in the interface |
| Observation/explanation submission and immediate feedback | PASSED for one constructed nonmatching prediction |
| Submitted answers and feedback after reopening | PASSED for the three-question record and two-question review/boundary record |
| Matching-prediction feedback path | PASSED for an explicitly constructed, already-exposed retry; retention/refinement accepted |
| Learner-authored review and new-condition question | PASSED with constructed tester responses; 20/20 each and feedback recovered |
| Method-only request boundary | PASSED on third attempt after two unsatisfactory attempts and text refinements |
| Ordinary quiz regression beyond this POE record | PASSED after the model corrected the generated question count; single-choice submission and explanation checked |
| Normal lesson-page navigation | PASSED; general browser/multi-tab stability not established |
| Audio | NOT_TESTED: no available voices; mute control disabled |
| Real-student learning outcomes | NOT_STUDIED |

The tested route is usable after the documented review and repairs. Results are limited to this model, deployment and constructed inputs. They do not establish reliable first-pass generation across topics, model adherence in general, audio availability or learning effectiveness. Content generation, saved learner state and feedback behavior remain separate claims.
