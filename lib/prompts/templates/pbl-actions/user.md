## PBL Scene Information

**Title**: {{title}}
**Project Topic**: {{projectTopic}}
**Project Description**: {{projectDescription}}
**Key Points**: {{keyPoints}}
**Description**: {{description}}
{{courseContext}}
{{agents}}

**Language Directive**: {{languageDirective}}

{{#if groundingContext}}
## Retrieved Reference Material

Use these excerpts to keep the project introduction and case guidance factually correct. Do not mention source files or retrieval in the narration. Do not invent conflicting technical procedures.

{{groundingContext}}
{{/if}}

Please generate the speech content for this PBL scene.

Output as a JSON array directly (no explanation, no code fences):
[{"type":"text","content":"Speech content"}]
