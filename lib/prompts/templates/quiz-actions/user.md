Questions: {{questions}}
Title: {{title}}
Key Points: {{keyPoints}}
Description: {{description}}
{{courseContext}}
{{agents}}

**Language Directive**: {{languageDirective}}

{{#if groundingContext}}
## Retrieved Reference Material

Use these excerpts to keep explanations and answer guidance factually correct. Do not mention source files or retrieval in the narration. Do not contradict technical details in the material.

{{groundingContext}}
{{/if}}

Output as a JSON array directly (no explanation, no code fences, 3-6 segments):
[{"type":"text","content":"Let's test your understanding"}]
