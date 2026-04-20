## Whiteboard Reference

### Canvas Specifications

**Dimensions**: 1000 × 562 pixels.

**Coordinate system**: `x = 0` at the left edge, `x = 1000` at the right edge. `y = 0` at the top, `y = 562` at the bottom. Every element has `(left, top)` at its top-left corner.

**Safe zone**: keep content within `x ∈ [20, 980]` and `y ∈ [20, 542]` to leave a 20px margin from the canvas edges.

**Reference points**:
- Centered horizontally: `x = (1000 - width) / 2`
- Centered vertically: `y = (562 - height) / 2`
- Two-column layout: left column `x ∈ [20, 480]`, right column `x ∈ [520, 980]` (40px gutter)

### JSON Output Context

Whiteboard actions are `{"type":"action","name":"wb_...", "params":{...}}` items inside the JSON array your response is required to be. All positions are integers (or decimals accepted, but stay in pixel units).

**LaTeX fields deserve special care — see the "LaTeX JSON Escape" section below.**

### Action Reference

For every whiteboard action, the JSON shape below is the **complete, canonical** form. All other prose in this file assumes these shapes.

#### wb_open

Open the whiteboard before drawing. Once open, `wb_draw_*` calls auto-render.

```json
{"type":"action","name":"wb_open","params":{}}
```

No parameters. Call before any `wb_draw_*`. Not required before every `wb_draw_*` — only once at the start of a drawing phase.

#### wb_draw_text

Place plain text. Use for notes, steps, labels — **not** for math formulas (use `wb_draw_latex` instead).

```json
{"type":"action","name":"wb_draw_text","params":{"content":"Step 1: identify forces","x":60,"y":60,"width":600,"height":43,"fontSize":18,"color":"#333333"}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | Plain text or HTML `<p>` block. No LaTeX commands. |
| `x` | number | yes | Left edge in pixels. |
| `y` | number | yes | Top edge in pixels. |
| `width` | number | no (default 400) | Text container width. |
| `height` | number | no (default 100) | Text container height. Use the Font Size Table below to pick a matching height. |
| `fontSize` | number | no (default 18) | Point size. Pick from the Font Size Table. |
| `color` | string | no (default `#333333`) | Hex color. |
| `elementId` | string | no | Stable ID for later `wb_delete`. |

**Common mistake**: embedding LaTeX like `"content":"\\frac{a}{b}"` in a text element — KaTeX is NOT run on text content, so the raw backslash prints. Use `wb_draw_latex` for any math.

#### wb_draw_shape

Place a geometric shape. Use for annotations, groupings, or simple diagrams.

```json
{"type":"action","name":"wb_draw_shape","params":{"shape":"rectangle","x":60,"y":200,"width":200,"height":100,"fillColor":"#5b9bd5"}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `shape` | `"rectangle"` \| `"circle"` \| `"triangle"` | yes | Primitive shape. |
| `x`, `y` | number | yes | Top-left of the shape's bounding box. |
| `width`, `height` | number | yes | Bounding box size. |
| `fillColor` | string | no (default `#5b9bd5`) | Hex fill color. |
| `elementId` | string | no | Stable ID. |

**Common mistake**: drawing a "parabola" as `wb_draw_shape` with `shape:"triangle"` or as a sequence of `wb_draw_line` segments. Neither renders a curve — there is no function-plot primitive. Prefer explaining algebraically or with a table of key points until this gap is closed.

#### wb_draw_line

Draw a straight line or arrow.

```json
{"type":"action","name":"wb_draw_line","params":{"startX":100,"startY":300,"endX":400,"endY":300,"color":"#333333","width":2,"points":["","arrow"]}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `startX`, `startY` | number | yes | Start coordinates. |
| `endX`, `endY` | number | yes | End coordinates. |
| `color` | string | no (default `#333333`) | Hex color. |
| `width` | number | no (default 2) | **Stroke thickness**, NOT line length. Keep 2–4. |
| `style` | `"solid"` \| `"dashed"` | no (default `"solid"`) | Line style. |
| `points` | `[start, end]` of `""` or `"arrow"` | no (default `["",""]`) | Arrow markers at each end. |
| `elementId` | string | no | Stable ID. |

**Common mistake**: setting `width` to the desired span (e.g., 300). `width` is stroke thickness; arrow markers scale with it — `width:60` produces a 180×180 arrowhead.
