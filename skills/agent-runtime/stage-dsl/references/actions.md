# Playback actions field reference

Actions are the ordered playback verbs at `scene.actions`.

They are separate from `scene.content`: content says what the page contains;
actions say what happens over time.

This chapter is derived from the shared `@openmaic/dsl` Action union,
`applyActionEdit`, and the scene validators.

## Root and ordering

```json
"actions": [
  { "id": "a1", "type": "speech", "text": "Welcome." }
]
```

The array is optional on the shared scene type. An absent array and an empty
array both mean there are no playback actions available to run.

Array order is playback order.

All variants include:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | action identity |
| `type` | action-type union | yes | selects the variant |
| `title` | string | no | optional authoring/display metadata |
| `description` | string | no | optional authoring/display metadata |

The pure runtime validator checks the id, known type, and each variant's
required fields. The cross-language JSON Schema is stricter about every
optional field. The app's interactive/PBL write boundary does not currently
run that full JSON Schema, so preserve known fields and do not treat tolerance
of an unknown nested member as authorization to invent it.

## Visual pointer actions

### `spotlight`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `elementId` | string | yes | slide element to focus |
| `dimOpacity` | number | no | opacity of the dimmed region |

### `laser`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `elementId` | string | yes | slide element to point at |
| `color` | string | no | laser color |

### `play_video`

`elementId: string` is required and identifies the slide video element.

The type system does not prove that any referenced element exists or is the
right slide element type. Cross-check `scene.content.canvas.elements`.

These actions are slide-oriented. The shared `SLIDE_ONLY_ACTIONS` list is the
runtime's authoritative category; do not attach them to a non-slide scene just
because the generic scene shape accepts an actions array.

## Speech

### `speech`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `text` | string | yes | narration text |
| `audioId` | asset reference string | no | synthesized narration asset |
| `audioInvalidated` | boolean | no | prevents legacy derived-id fallback after invalidation |
| `voice` | string | no | voice hint/binding field |
| `speed` | number | no | playback/synthesis speed field |

When a generic pointer changes an existing speech action's `text`,
`patch_stage` preserves the retired `set_speech` op's safety behavior and
removes stale `audioId` (and historical `audioUrl`) in that op.

The new line is silent until `generate_tts` synthesizes it. `generate_tts`
remains available.

If one atomic batch deliberately sets new text and a known new audio id, put
the text op first and the audio-id op second. Stale-audio cleanup happens when
the text op is applied.

## Whiteboard lifecycle

### `wb_open`

No variant-specific fields.

### `wb_close`

No variant-specific fields.

### `wb_clear`

No variant-specific fields.

### `wb_delete`

Requires `elementId: string` naming a whiteboard element.

The data contract does not enforce lifecycle order. Opening before drawing,
deleting only existing ids, and closing after work are runtime/procedure
responsibilities.

## Whiteboard drawing

### `wb_draw_text`

Required:

- `content: string`
- `x: number`
- `y: number`

Optional:

- `elementId: string`
- `width: number`
- `height: number`
- `fontSize: number`
- `color: string`

### `wb_draw_shape`

Required:

- `shape: "rectangle" | "circle" | "triangle"`
- `x`, `y`, `width`, `height`: numbers

Optional `elementId` and `fillColor` are strings.

### `wb_draw_chart`

Required:

- `chartType`: `bar` / `column` / `line` / `pie` / `ring` / `area` / `radar` / `scatter`
- `x`, `y`, `width`, `height`: numbers
- `data.labels: string[]`
- `data.legends: string[]`
- `data.series: number[][]`

Optional `elementId: string` and `themeColors: string[]`.

The action type does not verify series/label dimensions.

### `wb_draw_latex`

Required `latex: string`, `x: number`, and `y: number`.

Optional `elementId`, `width`, `height`, and `color`.

The contract does not parse LaTeX.

### `wb_draw_table`

Required `x`, `y`, `width`, `height`, and `data: string[][]`.

Optional `elementId`.

Optional `outline` has required `width:number`, `style:string`, and
`color:string` when the object is present.

Optional `theme` has required `color:string` when present.

The action contract leaves outline `style` open as a string; do not copy the
slide table's closed line-style assumption here without renderer evidence.

### `wb_draw_line`

Required numeric fields:

```text
startX | startY | endX | endY
```

Optional:

- `elementId: string`
- `color: string`
- `width: number`
- `style: "solid" | "dashed"`
- `points`: one of `['','arrow']`, `['arrow','']`,
  `['arrow','arrow']`, or `['','']`

### `wb_draw_code`

Required:

- `language: string`
- `code: string`
- `x: number`
- `y: number`

Optional `elementId`, `width`, `height`, and `fileName`.

The language string is open. Syntax support depends on the consumer and is not
validated here.

### `wb_edit_code`

Required:

- `elementId: string`
- `operation`: `insert_after` / `insert_before` / `delete_lines` / `replace_lines`

Optional:

- `lineId: string`
- `lineIds: string[]`
- `content: string`

Which optional fields are required for each operation is not expressed by the
persisted union. Read a working action or the whiteboard runtime before
constructing one.

## Discussion

### `discussion`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `topic` | string | yes | discussion topic |
| `prompt` | string | no | additional discussion instruction |
| `agentId` | string | no | selected agent identity |

The contract does not prove that `agentId` belongs to the stage roster.

## Widget actions

### `widget_highlight`

Requires `target: string`; optional `content: string`.

### `widget_setState`

Requires `state: Record<string, unknown>`; optional `content: string`.

The state payload is intentionally open because each widget owns its state
shape.

### `widget_annotation`

Requires `target: string`; optional `content: string`.

### `widget_reveal`

Requires `target: string`; optional `content: string`.

The target selector/id language and its existence are widget-owned and are not
validated by the course document.

## Synchronous categories

The shared contract exports three runtime lists:

- `FIRE_AND_FORGET_ACTIONS`
- `SLIDE_ONLY_ACTIONS`
- `SYNC_ACTIONS`

Those lists, not guesses based on names, determine scheduling categories.

This reference does not duplicate their current members because the runtime
values are authoritative and may evolve with the contract package.

## Visible text projection

`read_stage detail:"text"` includes established user-facing strings:

- common action `title` and `description`
- speech `text`
- discussion `topic` and `prompt`
- whiteboard text `content`
- whiteboard code `code` and `fileName`
- widget target/content strings for highlight, annotation, and reveal
- widget set-state `content`, but not its open state JSON

Geometry, ids, answer-like state, audio ids, and colors are source-only.

## Generic pointer behavior

Action paths are rooted at the scene:

```text
/actions/0/text
/actions/1/elementId
/actions/2/dimOpacity
```

An array index is not a stable identity. Find it from fresh source by matching
the action `id`.

`set` replaces a field; `remove` deletes or splices. There is no action-specific
insert op in `patch_stage`. Inserting means setting the complete resulting
`/actions` array with ids chosen by the caller.

The retired `insert_speech` op minted `act-...` ids. The generic pointer
does not. Preserve existing ids and ensure any caller-created id is unique.

## Common rejection reasons

- Path begins `/content/actions` instead of `/actions`.
- Index no longer points to the action id read earlier.
- A required variant field is removed.
- `type` is unknown or changed without supplying its new required fields.
- `set` omits value or `remove` carries value.
- A path crosses a scalar or missing intermediate object.

## Common semantic mistakes not fully caught

- Element-targeting action points to a missing element.
- Speech text changes but TTS is not regenerated.
- A whiteboard edit runs before its draw/open action.
- Duplicate action ids are introduced in a whole-array rewrite.
- Widget target names do not exist in widget state/DOM.
- Discussion `agentId` is not in the course roster.
- Array reordering changes narration timing unintentionally.

## Worked example 1: reword speech safely

Read source:

```json
read_stage({
  "path": "/scenes/1",
  "detail": "source"
})
```

Locate the speech by id and note its index:

```text
/actions/2 = { "id":"act-intro", "type":"speech", ... }
```

Patch:

```json
patch_stage({
  "target": "/scenes/1",
  "intent": "Make the opening narration more direct",
  "ops": [
    {
      "op": "set",
      "path": "/actions/2/text",
      "value": "We will test this idea with one concrete example."
    }
  ]
})
```

Read source again. Verify the new text and the absence of the old `audioId`.
Then call `generate_tts` for this scene and read back once more.

## Worked example 2: retarget a spotlight

Read the slide source and verify both ids:

```text
/content/canvas/elements/4/id = "el-result"
/actions/3 = { "id":"act-focus", "type":"spotlight", ... }
```

Patch only the reference:

```json
patch_stage({
  "target": "/scenes/scene_slide",
  "intent": "Move the spotlight to the result label",
  "ops": [
    {
      "op": "set",
      "path": "/actions/3/elementId",
      "value": "el-result"
    }
  ]
})
```

Read source again and confirm no action ordering changed.

## Worked example 3: remove an optional discussion prompt

Read `/scenes/4/actions` with `detail:"source"` and locate the discussion index.

```json
patch_stage({
  "target": "/scenes/4",
  "intent": "Let the discussion topic stand without an extra prompt",
  "ops": [
    {
      "op": "remove",
      "path": "/actions/1/prompt"
    }
  ]
})
```

Read `/scenes/4/actions` again and verify `topic`, `id`, and position remain.

## Hard rules

- Locate actions by id in fresh source, then use the current array index.
- Preserve ids when editing or reordering.
- Re-synthesize narration after speech text changes.
- Cross-check every elementId/agentId/target against its owning structure.
- Write complete arrays only when a leaf cannot express the change.
- Read back after every write.
