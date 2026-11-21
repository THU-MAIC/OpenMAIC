# 探究课（预测—观察—解释）：local checks

This is a manual product-validation protocol for the experimental built-in skill `predict-observe-explain`. Test inputs are constructed by the tester, not student data. Loading checks do not establish instructional quality or learning effectiveness.

## Discover and load

1. Open the workbench and find **探究课（预测—观察—解释）** in the skill menu.
2. Invoke `/predict-observe-explain` with a bounded phenomenon-based lesson request.
3. Confirm that the runtime reads this skill, settles a page plan and creates actual persisted pages using the existing stage workflow.
4. Verify that a request only to explain POE receives a method explanation without creating a classroom or forcing an activity.

## Minimal classroom

Use the ideal-vacuum falling-balls example in `references/inquiry-lesson.md`, or another independently checked phenomenon. Keep prediction, observation, explanation, teacher synthesis and a new-condition check identifiable; do not use page count as acceptance evidence.

### Prediction before feedback

- Inspect all visible initial content, narration, other questions and page-directory thumbnails for result leakage.
- Record a prediction and its reason without viewing the result. Include “uncertain” as a valid stance.
- The current short-answer submit path must not be assumed to disable AI grading through `hasAnswer: false`. Prefer one record with prediction, observation and explanation questions, completed in two visits. On the first visit fill only the prediction; verify that leaving the observation/explanation questions empty keeps submission disabled. Confirm draft retrieval before relying on it.
- Navigate away and return, refresh, then close and reopen the lesson. Retrieve the original prediction and reason. Do not replace that record with a retrospective claim.
- If a result has already been revealed, label the attempt accordingly. Use a fresh question for a new unseen-result prediction.

### Observe, record and explain

- Start the simulation or reveal the observation material only after the prediction.
- Verify beginning, intermediate and end states, units, repeatability and consistency with the supplied model or source. Mark model output as model output.
- Record a concrete observation separately from an explanation.
- Return to the record, preserve the original prediction and complete the observation and explanation questions. Submit only after observing; cite at least one observation and state what is retained, refined or revised.
- Check that feedback responds to the actual input without replacing the learner's own review. Each short-answer grading call only receives that question and response: do not accept feedback that invents what another answer said or treats an initially unmatched prediction as learning failure.
- Exercise both an initially matching prediction and a prediction that differs from the observation. Matching predictions do not require a fabricated change of mind.

### Persistence, revision and boundary

- Retrieve the explanation and feedback after reopening.
- Record a learner-authored review after feedback: retain, refine or revise the explanation and state why. Retrieve that record and distinguish it from the pre-feedback attempt. Do not claim the UI exposes a complete history unless directly checked.
- Complete a fresh condition-change question before seeing its answer. State the model's limits.
- Check a related existing quiz and normal page navigation as a regression smoke test.

## Report

In `LOCAL_VALIDATION.md`, record the actual base commit, tested skill version, model, generated/edited page coverage, observed behavior, any manual repairs and excluded capabilities. Separate classroom-content persistence, learner-state persistence, feedback behavior, audio and learning-effect evidence. Do not publish credentials, local endpoints, machine paths, private session ids or learner data.

No result is marked passed until the corresponding operation is actually exercised.
