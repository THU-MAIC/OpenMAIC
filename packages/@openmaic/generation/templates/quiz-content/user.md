Title: {{title}}
Description: {{description}}
Test Points: {{keyPoints}}
Question Count: {{questionCount}}, Difficulty: {{difficulty}}, Question Types: {{questionTypes}}

## Language Directive
{{languageDirective}}

Output a JSON array directly (no explanation, no code blocks, no LaTeX). Each choice option MUST be `{ "label": "<content text>", "value": "<one ASCII uppercase letter A-Z>" }`. `value` is an enum A-Z and is never the option content; `label` is the content text and is never just the letter. Never reverse them (invalid: `{ "value": "(6, 2)", "label": "A" }`). `answer` MUST be an array of those `value` letters, never the content text:
[{"id":"q1","type":"single","question":"Question text","options":[{"label":"Option A content","value":"A"},{"label":"Option B content","value":"B"},{"label":"Option C content","value":"C"},{"label":"Option D content","value":"D"}],"answer":["A"]}]
