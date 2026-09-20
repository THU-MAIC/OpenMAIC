Decide whether the following course request needs clarification before outline
generation. Apply the ask-vs-assume policy from the system prompt.

---

## User Requirements

{{requirement}}

---

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Web Search Results

{{researchContext}}

---

## Output Requirements

Respond with a single JSON object and nothing else — no prose, no code fences.

When no key parameter is ambiguous, return:

```json
{ "needsClarification": false, "questions": [] }
```

When clarification is needed, return the same shape with your own questions —
the placeholders below describe the format only and must NOT be copied as
content. Write questions about what is actually ambiguous in this request:

```json
{
  "needsClarification": true,
  "questions": [
    {
      "id": "q1",
      "question": "<your question here>",
      "options": [
        { "id": "<lowercase-slug>", "label": "<a concrete choice>" }
      ],
      "multiSelect": false,
      "allowFreeText": true
    }
  ]
}
```

`options` may be omitted for open questions. `multiSelect` and `allowFreeText`
default to `false` when absent.
