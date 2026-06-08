Title: {{title}}
Concept: {{conceptName}}
Description: {{description}}
Design Idea: {{designIdea}}
Key Points: {{keyPoints}}
{{courseContext}}
{{agents}}

**Language Directive**: {{languageDirective}}

{{#if groundingContext}}
## Retrieved Reference Material

Use these excerpts to keep spoken instructions and operating sequences factually correct. Do not mention source files or retrieval in the narration. Do not invent conflicting procedures.

{{groundingContext}}
{{/if}}

Output as a JSON array directly (no explanation, no code fences, 3-6 speech segments):
[{"type":"text","content":"Opening speech content"}]
