# Procedural Skill Widget Content Generator

Generate a complete, self-contained HTML procedural skill practice widget for an interactive lesson scene.

This widget is for task-oriented procedural practice. It should help a learner complete an operational task through stateful steps, local decisions, consequence feedback, progress, and reset. It is not a full vocational simulator, not a quiz, and not a platform protocol extension.

## Core Principle: Procedural Practice, Not Checklist

This is not a checklist.

Procedural-skill widgets are:

- Procedural practice, not static instructions.
- Task completion, not step scoring.
- Stateful practice, not a passive explanation.
- A lightweight operational proxy, not a full physical/mechanical simulator.

The learner must make at least one decision, judgment, measurement, or tool-use choice. Clicking Done cannot be the only meaningful interaction.

The widget should feel like practicing a small operational task: the learner observes a state, chooses or confirms an action, sees the consequence, and moves the task toward a safe/completed state.

## Visual Style Flexibility

Procedural-skill is a procedural training mechanism, not a fixed visual style.

Do not default every widget to the same dark dashboard or checklist panel. Choose a layout that fits the scene intent, title, description, and key points while preserving the same runtime contract.

Useful visual directions include:

- light step-card board
- work-order desk
- safety inspection station
- measurement station
- process kanban
- simulator-like control board
- GO/STOP decision station
- handoff checklist board
- troubleshooting station

Regardless of visual style, the widget must remain interactive and preserve task operation, state, decision, feedback, progress, reset, completion checking, stable selectors, and postMessage compatibility. Do not turn visual variety into a read-only PPT page.

## Output Structure

Your output must be a complete HTML document with:

1. Standard HTML5 structure.
2. Embedded widget configuration in a `<script type="application/json" id="widget-config">` tag.
3. A clear task title and short task description.
4. A tools/materials area when tools are provided.
5. A visible `#feedback-panel` for learner feedback and status messages.
6. A visible state/status panel for device state, task state, risk state, inspection result, or operation result. You may also use `#state-panel`, but it cannot replace `#feedback-panel`.
7. An ordered step list with visible, enabled, clickable learner controls.
8. At least one decision/judgment interaction that is not just a Done button.
9. At least one lightweight operation proxy such as a measurement reading, threshold range, meter/gauge/indicator, tool-use state, inspection result, or safety status signal.
10. At least one consequence feedback path for an incorrect or unsafe choice.
11. A progress indicator.
12. A visible, enabled, clickable reset button.
13. Mobile-responsive layout with no overlapping controls.
14. A platform-to-iframe `postMessage` listener for existing widget action message types only.

Return only the HTML document. Do not wrap the result in Markdown fences.

## Widget Config Schema

The embedded widget config must be valid JSON and must use this minimum shape:

```json
{
  "type": "procedural-skill",
  "task": "...",
  "description": "...",
  "tools": ["..."],
  "steps": [
    {
      "id": "step-1",
      "title": "...",
      "description": "...",
      "tools": ["..."],
      "successCriteria": ["..."]
    }
  ],
  "successCriteria": ["..."],
  "errorConsequences": ["..."]
}
```

Requirements:

- `type` must be exactly `"procedural-skill"`.
- Step IDs must be stable DOM-friendly IDs such as `step-1`, `step-2`, `step-3`.
- If the input provides only plain step strings, convert them into the minimum step objects.
- Preserve input error consequences when provided and use them for unsafe or incorrect feedback paths.
- Keep the config generic. Do not hard-code automotive, repair, or any other demo-specific scenario unless it is present in the input.

## Interaction Requirements

Build a minimal stateful procedural practice UI.

- Each task must include a clear goal, tools/materials, step list, visible feedback panel, state/status panel, progress display, success criteria, and reset.
- At least one step must require a decision or judgment, such as choosing a tool, checking whether a reading is within a safe threshold, entering or confirming a measurement, deciding whether recheck is required, judging safe/unsafe status, or choosing the next operation.
- At least one interaction must use a lightweight operation proxy, such as a reading, threshold range, meter/gauge/indicator, tool-use state, inspection result, or safety status signal.
- A Done button may exist, but Done cannot be the only meaningful interaction.
- Each step should provide local feedback tied to observed state and success criteria when available.
- The widget should allow non-perfect progress: a learner may make a wrong/unsafe choice, see a consequence, and recheck or retry without resetting the whole widget.
- The progress display should update only when steps are completed or reset.
- The reset button must be visible, enabled, clickable, and must call a central `resetState()` function or equivalent full reset path. It must restore all learner state, not just change a single text node.

Do not implement full simulation physics, domain-specific machinery, scoring systems, backend calls, data persistence, or cross-frame reporting.

## Visible Step Control Requirements

Stable selector targets must be usable, not empty placeholders.

- `#step-1-control`, `#step-2-control`, and other step controls must be real learner controls, not empty containers.
- Step controls must be visible, enabled, and clickable.
- Prefer `<button>`, `<input>`, `<select>`, or a semantic element with an explicit click handler and keyboard handler.
- `#step-1-control` must contain visible text or visible control content, such as "Complete step", "Check", "Measure", "Choose", "Go", or "Stop".
- Do not generate an empty control container such as `<div id="step-1-control"></div>`.
- Clicking a step control must update at least one visible state: `#progress-display`, the step row class/state, `#feedback-panel`, `#state-panel`, or success criteria gating.
- At least one learner action must visibly change progress or feedback without relying on widget actions.
- Step controls should remain reachable with mouse, touch, and keyboard.

## State Panel Requirements

The HTML must include `#feedback-panel` as a visible text/status area for learner feedback. `#feedback-panel` is mandatory even when a separate `#state-panel` exists.

You may add a dedicated `#state-panel` if useful, but `#state-panel` cannot replace `#feedback-panel`.

The state/status area must:

- Show current device state, risk state, task state, inspection result, operation result, or safety status.
- Change when the learner makes a meaningful interaction.
- Show risk, blocked, recheck, or safe/complete state when relevant.
- Reset to its initial state when `#reset-btn` is clicked.

Do not make the feedback or state panel static decorative text.

## Decision / Judgment Step Requirements

At least one step must be a judgment interaction, not a simple Done button. Use one of these lightweight patterns:

- Choose the correct tool or material for the next operation.
- Judge whether a measurement reading is inside a safe threshold range.
- Input or confirm a measurement value.
- Decide whether a failed check requires rework or recheck.
- Decide whether the device/task is safe or unsafe.
- Choose the next operation based on current state.

The judgment should update step feedback, state/status, progress, and success criteria state.

## Consequence Feedback Requirements

At least one incorrect/unsafe path must show a real consequence or state change. Feedback should be phrased as an operational consequence, such as:

- risk detected
- unsafe state
- inspection blocked
- requires recheck
- deviation detected
- warning / alarm
- cannot proceed until condition is resolved

Do not use only "Correct", "Wrong", or "Try again" as the main feedback. Do not use scores as a substitute for consequences.

## Operation Proxy Requirements

Include at least one lightweight operation proxy that gives the learner something to inspect or manipulate without requiring full simulation physics.

Good operation proxies include:

- A measurement reading with a safe threshold range.
- A meter, gauge, indicator, or status signal.
- A tool-use state such as selected tool, connected probe, locked switch, or checklist item under inspection.
- An inspection result that changes after user input.
- A safety status signal that changes when a condition is resolved.

Keep the proxy simple, deterministic, and local to the widget. Do not load external resources or build complex mechanical simulation.

## Success Criteria Gating

Success criteria must update based on actual state, not by default.

- Do not render success criteria as completed on initial load.
- "All checks completed" can only be satisfied when all required steps/conditions are truly complete.
- If only 1 of N steps is complete, do not visually mark the overall success criterion as complete.
- Individual success criteria should clearly show pending/completed/blocked state when practical.
- Reset must return success criteria to pending state.

This prevents the UI from claiming completion before the learner has actually met the task conditions.

## Runtime State Synchronization

The widget must keep learner clicks, reset, and widget action `SET_WIDGET_STATE` on one consistent state model.

- Use one central state object for completed steps, feedback/status, risk/decision state, operation proxy values, disabled control state, and success criteria state.
- Use one shared `renderState()` / `updateUI()` / equivalent render path after every learner click, reset, and `SET_WIDGET_STATE`.
- Click handlers and postMessage `SET_WIDGET_STATE` must not duplicate incompatible update logic. If a click can update progress, `SET_WIDGET_STATE` with the same completed step must update the same visible UI.
- `resetState()` or the equivalent reset path must clear `completedSteps`, return `#progress-display` to 0, restore `#feedback-panel` to its initial prompt, restore `#state-panel` / risk / decision / proxy state to initial values, remove completed classes from step rows, return success criteria to pending, clear highlights/annotations, and restore initial enabled/disabled controls.
- `SET_WIDGET_STATE` must support `data.state.completedSteps`. When received, it must synchronize the internal state and then re-render step row completed classes, `#progress-display`, `#feedback-panel`, `#state-panel` if present, and `#success-criteria` gating.
- `SET_WIDGET_STATE` must not only store internal variables. It must produce visible UI updates.
- If a reset or `SET_WIDGET_STATE` changes disabled controls, first confirm each target element exists.

## Null-Safe DOM Operations

Generated JavaScript must be defensive about optional or missing DOM targets.

- Use a helper such as `const el = document.querySelector(selector); if (!el) return;` before writing to DOM nodes.
- Do not set `disabled`, `textContent`, `className`, `style`, or event handlers on null elements.
- If an optional control, feedback node, or success criterion is absent, skip that update safely instead of throwing.
- `ANNOTATE_ELEMENT` must not throw when `data.content` is missing and must not throw when the target is absent.
- Missing optional elements must never cause errors such as `Cannot set properties of null`.

## Existing Teacher Action Listener

Your HTML may include a small `postMessage` listener, but it must only support the existing platform-to-iframe message types:

- `SET_WIDGET_STATE`
- `HIGHLIGHT_ELEMENT`
- `ANNOTATE_ELEMENT`
- `REVEAL_ELEMENT`

MAIC's renderer sends iframe messages using `event.data.type` as the platform message field. Generated HTML must read `event.data.type`; do not invent alternate message fields.

Use a listener pattern equivalent to:

```js
window.addEventListener("message", (event) => {
  const data = event.data || {};
  const messageType = data.type;

  if (messageType === "SET_WIDGET_STATE") {
    // Read data.state.
  }

  if (messageType === "HIGHLIGHT_ELEMENT") {
    // Read data.target.
  }

  if (messageType === "REVEAL_ELEMENT") {
    // Read data.target.
  }

  if (messageType === "ANNOTATE_ELEMENT") {
    // Read data.target. Use data.content when provided, but do not require it.
  }
});
```

For `SET_WIDGET_STATE`, read state from `data.state`. If `data.state.completedSteps` is provided, update the shared state and re-render step completion, progress, feedback, state/status, and success criteria using the same render path as learner clicks.
For `HIGHLIGHT_ELEMENT`, `REVEAL_ELEMENT`, and `ANNOTATE_ELEMENT`, read the selector from `data.target`.
For `ANNOTATE_ELEMENT`, do not assume `data.content` is always present. If there is no content, the widget should still avoid errors and may show a minimal default annotation or simply highlight the target.

Do not call `window.parent.postMessage`.
Do not invent new message types.
Do not introduce iframe-to-platform callbacks.

Stable teacher-action targets:

Your HTML must expose stable DOM targets so existing platform widget actions can highlight, annotate, reveal, or set state without custom renderer code.

- Task panel: `#task-panel`
- Tool/material list: `#tool-list`
- Ordered step list: `#step-list`
- Individual step row: `[data-step-id="step-1"]`
- Step controls: `#step-1-control`
- Step feedback: `#step-1-feedback`
- Success criteria: `#success-criteria`
- Progress display: `#progress-display`
- General feedback/status area: `#feedback-panel`
- Reset button: `#reset-btn`

Use the actual step ID from the embedded widget config for each step-specific target, such as `step-1`, `step-2`, and `step-3`.

For `SET_WIDGET_STATE`, support a minimal state object such as:

```json
{
  "completedSteps": ["step-1", "step-2"]
}
```

For `HIGHLIGHT_ELEMENT`, apply a temporary visible outline to the target element.
For `ANNOTATE_ELEMENT`, display a temporary annotation near the target element using `content` when provided.
For `REVEAL_ELEMENT`, make a hidden target element visible.

## Common Failure Modes

Avoid these failures:

- Do not generate a simple checklist.
- Do not make Done the only interaction.
- Do not mark all success criteria complete early.
- Do not use "Wrong" / "Try again" as the main feedback.
- Do not turn the task into a quiz or score-only exercise.
- Do not create a complex physical simulation.
- Do not add external dependencies.
- Do not invent new postMessage action types.
- Do not break stable teacher-action selectors.
- Do not call `window.parent.postMessage`.
- Do not create empty controls.
- Do not make `#step-1-control` an empty div.
- Do not hide the primary step control.
- Do not omit `#feedback-panel`.
- Do not use `#state-panel` as a replacement for `#feedback-panel`.
- Do not make progress impossible to change through visible controls.
- Do not implement reset as a visual-only text change.
- Do not leave `completedSteps` or completed row classes after reset.
- Do not ignore `data.state.completedSteps` in `SET_WIDGET_STATE`.
- Do not update internal state without re-rendering visible progress, feedback, state, and success criteria.
- Do not duplicate click and postMessage state logic in incompatible ways.
- Do not set `disabled`, `textContent`, `className`, or `style` on null elements.
- Do not let missing optional elements throw runtime errors.
- Do not use the same dark dashboard or checklist panel for every procedural task.
- Do not turn visual framing into a read-only PPT or passive explanation page.

## Technical Requirements

- Use inline CSS and JavaScript.
- Do not load external dependencies.
- Do not use external media assets.
- Use semantic HTML where practical.
- Use accessible labels for buttons and controls.
- Use touch targets of at least 44px.
- Avoid layout overlap on narrow screens.
- Keep JavaScript small and local to the widget.
- Keep all state inside the iframe document.

## Quality Checklist

Before finalizing the HTML, verify that:

- One decision / judgment interaction exists.
- One consequence feedback path exists.
- One state / status panel exists.
- One operation proxy exists.
- Clicking Done is not the only meaningful interaction.
- Step controls such as `#step-1-control` are visible, enabled, clickable, and not empty.
- `#feedback-panel` exists as a visible feedback/status area.
- `#state-panel` does not replace `#feedback-panel`.
- At least one visible learner control changes progress or feedback.
- Progress and success criteria are gated by actual state.
- Reset restores completed steps, proxy state, risk/status state, feedback, highlights, progress, success criteria, step row classes, and initial control disabled/enabled state.
- `SET_WIDGET_STATE` with `completedSteps` visibly updates step rows, progress, feedback, state/status, and success criteria through the shared render path.
- DOM writes are null-safe and never set `disabled`, `textContent`, `className`, or `style` on missing elements.
- Stable teacher-action selectors are present.
- The chosen visual style fits the scene intent and is not just the default dark checklist/dashboard pattern.
- The widget-config script is valid JSON.
- `widget-config.type` is exactly `"procedural-skill"`.
- The HTML is self-contained with inline CSS and JavaScript.
- No markdown fences or explanations are output.

## Language

Follow the requested language directive exactly when provided.
