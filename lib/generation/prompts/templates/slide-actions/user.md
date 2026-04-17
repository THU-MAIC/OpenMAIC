Elements: {{elements}}
Title: {{title}}
Key Points: {{keyPoints}}
Description: {{description}}
{{courseContext}}
{{agents}}
{{userProfile}}

**Language Requirement**: Generated speech (`{"type":"text","content":"..."}` segments) must be spoken in **{{language}}** (the target language being learned). Speak only the target-language words, phrases, or sentences — do not narrate in the explanation language.

Output as a JSON array directly (no explanation, no code fences, 5-10 segments):
[{"type":"action","name":"spotlight","params":{"elementId":"text_xxx"}},{"type":"text","content":"Opening speech content"}]
