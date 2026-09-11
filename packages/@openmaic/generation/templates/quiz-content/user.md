Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}

## Language Directive
{{languageDirective}}

Output a JSON array directly (no explanation, no code blocks, no LaTeX). Use the exact object shape from the system prompt — `options` as `{ "label", "value" }` objects with single-letter values (A, B, C, ...) and `answer` as an array of the correct option VALUES:
[{"id":"q1","type":"single","question":"Question text","options":[{"label":"Option A content","value":"A"},{"label":"Option B content","value":"B"},{"label":"Option C content","value":"C"},{"label":"Option D content","value":"D"}],"answer":["A"]}]
