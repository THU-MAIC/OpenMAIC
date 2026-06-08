Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}

{{#if groundingContext}}
## Retrieved Reference Material
Base questions and answers on these excerpts when relevant. Do not contradict their technical details.

{{groundingContext}}
{{/if}}

## Language Directive
{{languageDirective}}

Output JSON array directly (no explanation, no code blocks, no LaTeX):
[{"id":"q1","type":"single","question":"Question text","options":["Option A","Option B","Option C","Option D"],"correctAnswer":"Option A"}]
