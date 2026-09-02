# Quiz content field reference

This chapter describes the persisted quiz structure at `scene.content`.

It is derived from `@openmaic/dsl`'s `QuizContent`, `QuizQuestion`, and
`QuizOption` contracts, the quiz editor operations, and the document write
validator. It states only behavior those sources establish.

## Root

```json
{
  "type": "quiz",
  "questions": []
}
```

| Field | Type | Required | Legal values / meaning |
| --- | --- | --- | --- |
| `type` | string | yes | exactly `"quiz"`; must agree with `scene.type` |
| `questions` | `QuizQuestion[]` | yes | ordered question list |

The content root is closed for `patch_stage`: fields other than `type` and
`questions` are rejected.

The page title is `scene.title`, outside content. Change it with `edit_deck`,
not `patch_stage`.

## QuizQuestion

```json
{
  "id": "q1",
  "type": "single",
  "question": "Which value is prime?",
  "options": [
    { "label": "4", "value": "A" },
    { "label": "5", "value": "B" }
  ],
  "answer": ["B"],
  "analysis": "5 has no positive divisors other than 1 and itself.",
  "points": 1
}
```

| Field | Type | Required | Legal values / semantics |
| --- | --- | --- | --- |
| `id` | string | yes | stable question identity used by editor operations |
| `type` | string union | yes | `single` / `multiple` / `short_answer` |
| `question` | string | yes | learner-facing question stem |
| `options` | `QuizOption[]` | no | choice rows; normally used by single/multiple |
| `answer` | `string[]` | no | correct option values, or accepted short-answer values |
| `analysis` | string | no | answer explanation shown by quiz surfaces that expose analysis |
| `commentPrompt` | string | no | optional prompt field; exact rendering timing is not specified here |
| `hasAnswer` | boolean | no | signals whether a short-answer item has a supplied answer |
| `points` | number | no | score weight/value |

The question object is closed for `patch_stage`. A misspelling such as
`analaysis` is rejected rather than stored.

The runtime contract requires `id`, `type`, and `question` by type. The
`patch_stage` quiz check also verifies those fields are strings and that
`type` is one of the three values above.

No minimum or maximum string length is specified by the persisted type.

No positive-only or integer-only constraint is specified for `points` in the
type. Do not invent one.

## Question types

### `single`

The editor models the answer as `string[]` even when one option is correct.

The choice editor's `toggleCorrect` operation keeps single-choice behavior by
selecting one row. A generic pointer bypasses that menu behavior: when writing
`answer` directly, supply the complete intended array.

Example:

```json
"answer": ["B"]
```

### `multiple`

Multiple option values may appear in `answer`.

Example:

```json
"answer": ["A", "C"]
```

The persisted type does not require answer order to match option order, but
keeping it aligned makes diffs and review easier.

### `short_answer`

Choice `options` are optional and normally absent.

The grading code treats a short-answer question without `hasAnswer` as not
auto-gradable. This is an established consumer behavior, not a schema rule.

`answer` remains a string array when present.

## QuizOption

```json
{ "label": "5", "value": "B" }
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `label` | string | yes | learner-facing option text |
| `value` | string | yes | stable value stored in the question's `answer` array |

The option object is closed. Unknown fields and wrong types are rejected.

`label` and `value` are different. Changing a label preserves correctness only
when the value is unchanged. Changing a value requires updating every matching
entry in `answer` in the same atomic batch.

## Ordering and identity

`questions` array order is display order.

`options` array order is the displayed choice order.

Generic pointer writes address zero-based array indices. Read the source again
immediately before an index-based edit; an earlier insert or reorder changes
the index.

`patch_stage` has no quiz-specific add menu and does not mint quiz identities.
Adding a question or option means setting the complete resulting array,
including valid ids and option values supplied by the caller.

The pointer implementation accepts only canonical, already-existing array
indices. JSON Patch's conventional `/-` append token is **not supported**, and
an index equal to the current length is out of bounds. Read the current array,
append in memory, then `set` the array field to the complete result.

The existing runtime validator does not define an id format or global
uniqueness rule for quiz question ids. Preserve existing ids. For new ids,
follow the neighboring document's convention and ensure uniqueness yourself.

## Answer coupling

The important invariant is referential:

```text
question.answer[] value  ->  one question.options[].value
```

The TypeScript type permits values that do not point to an option. The generic
write validation does not prove this relationship. A structurally accepted
quiz may therefore still have an ungradeable or always-wrong answer.

When deleting an option, remove its value from `answer` in the same call.

When reassigning option values, update `answer` in the same call.

When changing `type`, inspect `options`, `answer`, and `hasAnswer` together.

## Visible text projection

`read_stage detail:"text"` includes:

- `question`
- every option `label`
- `analysis` when present
- `commentPrompt` when present
- visible action text attached to the scene

It does not treat `answer` values as learner-facing text.

`grep_stage scope:"text"` searches that same projection.

Use `scope:"source"` when looking for an option value, question id, field name,
or answer key.

## Common rejection reasons

- Path starts `/questions/...` instead of `/content/questions/...`.
- Question or option index is stale.
- An intermediate array/object does not exist.
- `remove` targets a missing optional field.
- A required field (`id`, `type`, `question`, root `questions`) is removed.
- A question type is not `single`, `multiple`, or `short_answer`.
- An option lacks a string `label` or `value`.
- An unknown question/option/content-root field is introduced.

## Common semantic mistakes that validation does not catch

- Correct answer values no longer exist in `options`.
- A `single` question has multiple answer values after a whole-array write.
- A `short_answer` question is expected to auto-grade but lacks `hasAnswer`.
- Duplicate question ids are introduced in a rewritten array.
- Option labels move but answer values are unintentionally regenerated.
- `points` is technically a number but unsuitable for the scoring policy.

## Worked example 1: change one option label

Read the source:

```json
read_stage({
  "path": "/scenes/2",
  "detail": "source"
})
```

Locate the exact option:

```text
/content/questions/0/options/1
  { "label": "5", "value": "B" }
```

Patch only its label:

```json
patch_stage({
  "target": "/scenes/2",
  "intent": "Clarify the second answer choice",
  "ops": [
    {
      "op": "set",
      "path": "/content/questions/0/options/1/label",
      "value": "5（质数）"
    }
  ]
})
```

Read back:

```json
read_stage({
  "path": "/scenes/2",
  "detail": "source"
})
```

Verify that the label changed and `value:"B"` plus `answer:["B"]` did not.

## Worked example 2: change an option value without breaking the key

Read source and locate:

```text
/content/questions/0/options/1/value = "B"
/content/questions/0/answer = ["B"]
```

Write both coupled fields atomically:

```json
patch_stage({
  "target": "/scenes/scene_quiz",
  "intent": "Rename the second option value while preserving correctness",
  "ops": [
    {
      "op": "set",
      "path": "/content/questions/0/options/1/value",
      "value": "prime"
    },
    {
      "op": "set",
      "path": "/content/questions/0/answer",
      "value": ["prime"]
    }
  ]
})
```

Read back source and confirm both writes landed together.

## Worked example 3: remove optional analysis

Read source first and prove `analysis` exists:

```json
read_stage({
  "path": "/scenes/2",
  "detail": "source"
})
```

Remove the leaf:

```json
patch_stage({
  "target": "/scenes/2",
  "intent": "Remove the outdated answer explanation",
  "ops": [
    {
      "op": "remove",
      "path": "/content/questions/0/analysis"
    }
  ]
})
```

Read source again, then optionally run:

```json
grep_stage({
  "query": "outdated phrase",
  "scope": "text"
})
```

The source must lack `analysis`, and the old visible phrase must have no hit.

## Worked example 4: add one question

After reading `/scenes/2` with `detail:"source"`, preserve every existing
question exactly and append the new complete object in the value written to the
array itself:

```json
patch_stage({
  "target": "/scenes/2",
  "intent": "Add a second quiz question",
  "ops": [
    {
      "op": "set",
      "path": "/content/questions",
      "value": [
        {
          "id": "q1",
          "type": "single",
          "question": "Which value is prime?",
          "options": [
            { "label": "4", "value": "A" },
            { "label": "5", "value": "B" }
          ],
          "answer": ["B"]
        },
        {
          "id": "q2",
          "type": "short_answer",
          "question": "Name the smallest prime number.",
          "answer": ["2"],
          "hasAnswer": true
        }
      ]
    }
  ]
})
```

Do not use `/content/questions/-`; it is rejected as a non-canonical array
index.

## Worked example 5: add one option

Read the complete current option array, append a new `{label,value}` pair, and
set `/content/questions/0/options` to that complete resulting array. If the new
option is correct, set `/content/questions/0/answer` in the same atomic batch.
Never write `/content/questions/0/options/-`.

## Hard rules

- Read source, never tree, to obtain indices and full neighboring state.
- Patch the smallest leaf unless coupled fields must change atomically.
- Preserve question ids and option values unless the intent explicitly changes them.
- Treat `answer` and option `value` as one invariant.
- Use complete arrays for additions/reorders; generic pointers do not mint quiz ids.
- Read back after every write.
