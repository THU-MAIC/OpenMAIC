Create a procedural skill widget for: {{title}}

## Procedure Type

{{procedureType}}

## Task

{{task}}

## Scene Description

{{description}}

## Key Points

{{keyPoints}}

## Tools or Materials

{{tools}}

## Ordered Steps

{{steps}}

## Success Criteria

{{successCriteria}}

## Error Consequences

{{errorConsequences}}

## Language

{{languageDirective}}

---

Generate a complete, self-contained HTML procedural skill widget with these mandatory features:

1. Embedded JSON config in `<script type="application/json" id="widget-config">`.
2. `widget-config.type` exactly equal to `"procedural-skill"`.
3. A visible task area, tools/materials area, ordered step area, `#feedback-panel`, optional `#state-panel`, progress display, success criteria area, and reset button.
4. Visible, enabled, clickable learner controls for actions. `#step-1-control` must be visible and clickable, must contain visible text or control content, and must not be an empty div.
5. At least one learner action must visibly update progress or feedback.
6. `#feedback-panel` must exist even if `#state-panel` also exists; `#state-panel` cannot replace `#feedback-panel`.
7. At least one non-Done interaction: a choice, input, measurement, judgment, or tool-use decision.
8. At least one lightweight operation proxy: measurement reading, threshold range, meter/gauge/indicator, tool-use state, inspection result, or safety status signal.
9. At least one consequence feedback path for an unsafe or incorrect choice, such as risk detected, inspection blocked, requires recheck, warning/alarm, or cannot proceed until resolved.
10. Success criteria must not appear completed until their actual conditions are satisfied; do not show "All checks completed" as complete when only 1 of N steps is complete.
11. A visible, enabled, clickable reset button that restores all learner state: progress, feedback, state/status, step classes, success criteria, proxy values, and initial enabled/disabled controls.
12. Reset must use a central `resetState()` or equivalent full reset path, not a visual-only text change.
13. A platform-to-iframe listener using only existing message types: `SET_WIDGET_STATE`, `HIGHLIGHT_ELEMENT`, `ANNOTATE_ELEMENT`, and `REVEAL_ELEMENT`.
14. The listener must use `event.data.type` because MAIC's renderer sends the platform message type in that field.
15. `SET_WIDGET_STATE` must read `data.state`; `HIGHLIGHT_ELEMENT`, `REVEAL_ELEMENT`, and `ANNOTATE_ELEMENT` must read `data.target`.
16. `SET_WIDGET_STATE` with `data.state.completedSteps` must update visible progress, step completion, feedback/status, and success criteria.
17. Learner click actions and widget action `SET_WIDGET_STATE` must use the same shared state update/render path.
18. Generated JavaScript must guard DOM access before writing to elements; never set `disabled`, `textContent`, `className`, or `style` on null elements.
19. No iframe-to-platform messages and no new postMessage action types.
20. Responsive, self-contained HTML with inline CSS and JavaScript only.
21. Choose a visual layout that fits this scene instead of defaulting every procedural-skill widget to the same dark dashboard or checklist panel. Possible layouts include a light step-card board, work-order desk, safety inspection station, measurement station, process kanban, simulator-like control board, GO/STOP decision station, handoff checklist board, or troubleshooting station.
22. Regardless of visual style, preserve task operation, decision, feedback, progress, reset, completion checking, stable selectors, and the existing postMessage listener contract.

Return only the full HTML document. Do not include Markdown fences or explanatory text.
