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

#### wb_draw_latex

Render a math formula via KaTeX.

```json
{"type":"action","name":"wb_draw_latex","params":{"latex":"\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}","x":100,"y":80,"height":80}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `latex` | string | yes | LaTeX source. **Every `\` must be written as `\\` in the JSON string — see "LaTeX JSON Escape" below.** |
| `x`, `y` | number | yes | Top-left. |
| `height` | number | no (default 80) | Preferred rendered height. See the LaTeX Element Height Table below. |
| `width` | number | no (default 400) | Max horizontal space. Auto-computed from height × aspect ratio unless this cap kicks in. |
| `color` | string | no (default `#000000`) | Hex color. |
| `elementId` | string | no | Stable ID. |

**Most common mistake**: single-backslash commands. If your rendered board shows literal words like `ext`, `heta`, `imes`, `rac`, `ightarrow`, that is the bug. Next response: rewrite with `\\text`, `\\theta`, etc.

#### wb_draw_chart

Render a data chart.

```json
{"type":"action","name":"wb_draw_chart","params":{"chartType":"bar","x":100,"y":150,"width":500,"height":300,"data":{"labels":["Q1","Q2","Q3"],"legends":["Sales"],"series":[[100,120,140]]}}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `chartType` | `"bar"` \| `"column"` \| `"line"` \| `"pie"` \| `"ring"` \| `"area"` \| `"radar"` \| `"scatter"` | yes | Chart kind. |
| `x`, `y`, `width`, `height` | number | yes | Bounding box. |
| `data.labels` | string[] | yes | X-axis labels. |
| `data.legends` | string[] | yes | Series names (one per row in `series`). |
| `data.series` | number[][] | yes | One inner array per legend, length matches `labels`. |
| `themeColors` | string[] | no | Palette override. |
| `elementId` | string | no | Stable ID. |

**Common mistake**: placing a chart that extends past `x + width = 1000` or `y + height = 562` — charts silently clip at canvas edges.

#### wb_draw_table

Render a simple table.

```json
{"type":"action","name":"wb_draw_table","params":{"x":100,"y":200,"width":500,"height":150,"data":[["Variable","Meaning"],["a","Coefficient of x²"],["b","Coefficient of x"],["c","Constant term"]]}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `x`, `y`, `width`, `height` | number | yes | Bounding box. |
| `data` | string[][] | yes | 2D array. First row is header. All rows same length. |
| `outline` | `{width, style, color}` | no | Border style. |
| `theme` | `{color}` | no | Header color. |
| `elementId` | string | no | Stable ID. |

**Common mistake**: putting LaTeX into table cells (`"data":[["y = \\frac{1}{2}"]]`). Cell text is rendered as plain text; the backslashes stay. Put the formula in a separate `wb_draw_latex` adjacent to the table.

#### wb_draw_code

Draw a code block with syntax highlighting. Includes a ~32px header bar.

```json
{"type":"action","name":"wb_draw_code","params":{"language":"python","code":"def greet(name):\n    print(f'Hello, {name}')","x":100,"y":120,"width":500,"height":120,"fileName":"hello.py","elementId":"code1"}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `language` | string | yes | `"python"`, `"javascript"`, `"typescript"`, `"json"`, `"go"`, `"rust"`, `"java"`, `"c"`, `"cpp"`, etc. |
| `code` | string | yes | Source. Use `\n` for newlines. |
| `x`, `y` | number | yes | Top-left. |
| `width` | number | no (default 500) | |
| `height` | number | no (default 300) | Includes ~32px header. Budget ≈ 32 + 22 per line + 16 padding. |
| `fileName` | string | no | Shown in the header bar. |
| `elementId` | string | no | **Recommended** — lets you edit the block later with `wb_edit_code`. |

**Common mistake**: underestimating height — a 10-line block needs ~270px.

#### wb_edit_code

Modify an existing code block line-by-line. Produces smooth animations — prefer this over redrawing.

```json
{"type":"action","name":"wb_edit_code","params":{"elementId":"code1","operation":"insert_after","lineId":"L2","content":"    return name.upper()"}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `elementId` | string | yes | Target code block's ID. |
| `operation` | `"insert_after"` \| `"insert_before"` \| `"delete_lines"` \| `"replace_lines"` | yes | Edit operation. |
| `lineId` | string | for inserts | Reference line ID (e.g., `"L2"`) — shown in state. |
| `lineIds` | string[] | for delete/replace | Lines to operate on. |
| `content` | string | for insert/replace | New code. Use `\n` for multiple lines. |

**Common mistake**: guessing line IDs. Read the current whiteboard state — every code line has a stable ID like `L1`, `L2`, visible in the state context.

#### wb_delete

Remove one element by ID.

```json
{"type":"action","name":"wb_delete","params":{"elementId":"step1"}}
```

**Common use**: step-by-step reveals (draw step 1 with `elementId:"step1"`, explain, delete, draw step 2).

#### wb_clear

Remove **all** elements from the whiteboard. Use sparingly — prefer `wb_delete` when 1-2 removals would do.

```json
{"type":"action","name":"wb_clear","params":{}}
```

#### wb_close

Close the whiteboard to reveal the slide canvas. **Do NOT call at the end of a drawing response** — students need time to read. Only close when returning to slide-canvas actions (spotlight/laser).

```json
{"type":"action","name":"wb_close","params":{}}
```

### LaTeX JSON Escape (CRITICAL)

This is the single highest-leverage rule on the whiteboard. Read it before every math-heavy response.

**The rule**: in any JSON string containing LaTeX — the `latex` param of `wb_draw_latex`, or a `content` param that happens to contain `\\text{...}` — **every backslash must be written as `\\` (two characters)** in your JSON output. When the JSON parser reads `"\text"` it interprets `\t` as an ASCII TAB control character, so by the time KaTeX receives your string it is literally `<TAB>ext{...}` — no `\text` command, just garbage.

Characters at risk (first character of the LaTeX command collides with a JSON escape):

| Control | JSON escape | LaTeX commands corrupted |
|---|---|---|
| TAB (`\t`) | `\t` | `\text`, `\theta`, `\times`, `\tau`, `\top`, `\tan` |
| CR (`\r`) | `\r` | `\rightarrow`, `\Rightarrow`, `\rho`, `\right`, `\real` |
| FF (`\f`) | `\f` | `\frac`, `\forall`, `\Phi`, `\phi`, `\flat` |
| BS (`\b`) | `\b` | `\beta`, `\binom`, `\bar`, `\bot` |
| VT (`\v`) | `\v` | `\varphi`, `\vec`, `\vdots`, `\vee`, `\varepsilon` |
| LF (`\n`) | `\n` | `\neq`, `\ni`, `\not`, `\notin` |

**Correctness table** (what you write in JSON → what KaTeX renders):

| LaTeX source | ❌ Wrong in JSON | ✅ Right in JSON |
|---|---|---|
| `\frac{a}{b}` | `"\frac{a}{b}"` | `"\\frac{a}{b}"` |
| `\text{合规}` | `"\text{合规}"` | `"\\text{合规}"` |
| `\theta` | `"\theta"` | `"\\theta"` |
| `\times` | `"\times"` | `"\\times"` |
| `\rightarrow` | `"\rightarrow"` | `"\\rightarrow"` |
| `\Rightarrow` | `"\Rightarrow"` | `"\\Rightarrow"` |
| `\circ` | `"\circ"` | `"\\circ"` |
| `\tau` | `"\tau"` | `"\\tau"` |
| `\forall` | `"\forall"` | `"\\forall"` |
| `\beta` | `"\beta"` | `"\\beta"` |
| `\varphi` | `"\varphi"` | `"\\varphi"` |
| `\sqrt{x}` | `"\sqrt{x}"` | `"\\sqrt{x}"` |
| `a^2 + b^2 = c^2` | `"a^2 + b^2 = c^2"` | `"a^2 + b^2 = c^2"` (no backslash — stays the same) |

**Self-check heuristic**: if your previous turn's rendered whiteboard shows literal tokens like `ext`, `heta`, `imes`, `rac`, `irc`, `ightarrow`, `orall`, `eta`, `arphi`, `eq`, you emitted single-backslash LaTeX. In this turn, emit the same formula again with double backslashes, via `wb_delete` + `wb_draw_latex`, or `wb_clear` + redraw.

**Good complete example**:

```json
{"type":"action","name":"wb_draw_latex","params":{"latex":"\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}","x":100,"y":80,"height":80}}
```

Renders as: the standard quadratic formula. Count the backslashes in the JSON: 4 pairs of `\\`. Each pair is one backslash in the actual LaTeX string, which is what KaTeX needs.

**Bad example** (this is what produces the `ext`-style garbage):

```json
{"type":"action","name":"wb_draw_latex","params":{"latex":"\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}","x":100,"y":80,"height":80}}
```

The JSON parser sees `\f` (form feed), `\p` (kept as `\p`), `\s` (kept as `\s`). KaTeX then receives a broken string where `\frac` is gone. Whether KaTeX complains or silently renders wrong, the board is broken.
