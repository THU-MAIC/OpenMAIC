Create a Task Engine outline from this vocational task request.

## User Task

{{requirement}}

---

{{userProfile}}

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Retrieved and External Reference Context

{{researchContext}}

{{teacherContext}}

---

Apply the system prompt's suitability gate first.

If the request is suitable for vocational procedural practice, generate the mixed Task Engine outline using the system prompt's scene contracts, first-slide constraints, procedural-skill requirements, game payload requirements, and output shape.

If the request is not suitable, generate a normal MAIC-style outline using slide plus ordinary interactive widgets only. Do not output `procedural-skill` for non-vocational topics.

Return ONLY the JSON object with `languageDirective` and `outlines`. Do not use markdown fences or explanatory text.
