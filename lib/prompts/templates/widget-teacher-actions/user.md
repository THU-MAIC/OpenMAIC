Generate teacher actions for this widget.

## Widget Type

{{widgetType}}

## Widget Description

{{description}}

## Key Points

{{keyPoints}}

## Widget Config

{{widgetConfig}}

## Course Language

{{languageDirective}}

---

Generate 3-7 teacher actions that guide the student through this widget.

**IMPORTANT**:
- For `setState` actions, use the EXACT variable names from the widget config above
- For `highlight`/`annotation` targets, use selectors matching the element ID convention:
  - Sliders: `#{variable_name}-slider`
  - Displays: `#{variable_name}-display`
  - Nodes (diagrams): `#n1`, `#n2`, etc. only when those targets exist in the SVG DOM
  - Edges (diagrams): `#edge-n1-n2`, `#edge-n2-n3` only when those targets exist in the SVG DOM
  - Diagram targets must be querySelector-addressable and guaranteed by the generated HTML; do not invent selectors that are not present in widget config or content HTML
  - Procedural-skill steps: `[data-step-id="step-1"]`, `#step-1-control`, `#step-1-feedback`
- For `procedural-skill`, prefer step IDs from the embedded widget config and the stable selector convention: `#task-panel`, `#tool-list`, `#step-list`, `#success-criteria`, `#progress-display`, `#feedback-panel`, `#reset-btn`
- For procedural-skill `setState`, use the existing `completedSteps` shape, e.g. `{ "completedSteps": ["step-1"] }`
- Do not generate action types outside the existing action engine support: `speech`, `highlight`, `annotation`, `reveal`, and `setState`
