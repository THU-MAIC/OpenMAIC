Elements: {{elements}}
Title: {{title}}
Key Points: {{keyPoints}}
Description: {{description}}
{{courseContext}}
{{agents}}
{{userProfile}}

**Language Directive**: {{languageDirective}}

{{#if groundingContext}}
## Retrieved Reference Material

Use these excerpts to keep spoken explanations factually correct. Do not mention source files or retrieval in the narration. Do not invent technical values, procedures, warnings, or diagnoses that conflict with them.

{{groundingContext}}
{{/if}}

Output as a JSON array directly (no explanation, no code fences, 5-10 segments):
[{"type":"action","name":"spotlight","params":{"elementId":"text_xxx"}},{"type":"text","content":"Opening speech content"}]
