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

{{#if groundingContext}}
## Retrieved Reference Material

Teacher actions and spoken guidance must follow the retrieved procedure, safety limits, component names, and operation order. Do not mention source files or retrieval to the student.

{{groundingContext}}
{{/if}}

---

Generate 3-7 teacher actions that guide the student through this widget.

**IMPORTANT**:
- For `setState` actions, use the EXACT variable names from the widget config above
- For `highlight`/`annotation` targets, use selectors matching the element ID convention:
  - Sliders: `#{variable_name}-slider`
  - Displays: `#{variable_name}-display`
  - Nodes (diagrams): `#n1`, `#n2`, etc.
