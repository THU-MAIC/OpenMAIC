## Whiteboard Reference

### Canvas Specifications

**Dimensions**: 1000 × 563 pixels.

**Coordinate system**: `x = 0` at the left edge, `x = 1000` at the right edge. `y = 0` at the top, `y = 563` at the bottom. Every element has `(left, top)` at its top-left corner.

**Safe zone**: keep content within `x ∈ [20, 980]` and `y ∈ [20, 543]` to leave a 20px margin from the canvas edges.

**Reference points**:
- Centered horizontally: `x = (1000 - width) / 2`
- Centered vertically: `y = (563 - height) / 2`
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

**Common mistake**: placing a chart that extends past `x + width = 1000` or `y + height = 563` — charts silently clip at canvas edges.

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

### Bounds & Overlap

The canvas is **1000 × 563**. Elements that extend past the edges are clipped.

**Hard bounds** (every element):
- `x ≥ 0` and `x + width ≤ 1000`
- `y ≥ 0` and `y + height ≤ 563`

**Safe zone** (preferred): `20 ≤ x`, `x + width ≤ 980`, `20 ≤ y`, `y + height ≤ 542`.

**Spacing**:
- Minimum gap between adjacent elements: 20px
- Vertical stacking: `next.y = prev.y + prev.height + 30`
- Side-by-side: `next.x = prev.x + prev.width + 30`

**Two-column layout**:
- Left column: `x ∈ [20, 480]`, width ≤ 460
- Right column: `x ∈ [520, 980]`, width ≤ 460
- Gutter: 40px

**Before placing every element, walk the existing elements** (listed in the "Current State" section of your context). For each existing `(x, y, width, height)`:

- Reject if the new bbox would cover > 30% of its area.
- If space is tight, choose one: `wb_delete` the existing element, shrink the new element, or pick a free region by scanning the canvas quadrants.

**Worked example** — adding a formula below an existing chart at (100, 80) size 500×200:

```
chart occupies x=100..600, y=80..280
next safe y  = 80 + 200 + 30 = 310
formula at (100, 310, height 80) → occupies y=310..390
check: y + height = 390 ≤ 563  ✓
check: no overlap with chart (chart ends at y=280, formula starts at y=310) ✓
```

### Font Size Table

For `wb_draw_text`:

| Content type | `fontSize` |
|---|---|
| Whiteboard title | 28-32 |
| Section heading | 20-24 |
| Body / annotation | 16-18 |
| Caption / fine print | 12-14 |

Keep 2-4px between adjacent hierarchy levels. **Do not use free-form sizes like 8, 11, 48, 64** — pick from this table.

For a given `fontSize` and 1-line text, a matching `height` is roughly `ceil(fontSize × 1.5) + 20` (1.5 line-height plus 10px top/bottom padding).

**Pair text and LaTeX by visual weight.** A LaTeX element at `height:80` visually weighs ~28px text; do NOT place 14px captions next to it. Use this table:

| LaTeX `height` | Companion text `fontSize` |
|---|---|
| 50-60 | 16-20 |
| 70-80 | 20-24 |
| 90-110 | 24-28 |
| 120+ | 28-32 |

When a formula and annotation sit on the same board, their visual weights should match. Large formula next to tiny caption looks broken.

### LaTeX Element Height Table

For `wb_draw_latex` — use the category that best matches your formula:

| Category | Examples | `height` |
|---|---|---|
| Inline equations | `E=mc^2`, `a+b=c` | 50-80 |
| With fractions | `\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}` | 60-100 |
| Integrals / limits | `\\int_0^1 f(x)dx`, `\\lim_{x \\to 0}` | 60-100 |
| Summations with limits | `\\sum_{i=1}^{n} i^2` | 80-120 |
| Matrices | `\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}` | 100-180 |
| Standalone fractions | `\\frac{a}{b}` | 50-80 |
| Nested fractions | `\\frac{\\frac{a}{b}}{\\frac{c}{d}}` | 80-120 |

Width is auto-computed from `height × aspect_ratio`; `width` acts as a horizontal cap only.

**Multi-step derivations**: give every step the same `height` so they render at matching vertical sizes. Widths will differ — that's correct; it reflects each step's horizontal complexity.

### Pre-Output Checklist

Before emitting whiteboard actions, mentally walk through these:

1. **[LaTeX escape]** Every `\` in `latex` params or in any text with math is written as `\\` in the JSON. Scan for single-backslash `\frac`, `\text`, `\theta`, `\times`, `\rightarrow`, `\circ`, `\beta`, `\varphi` — none should appear.
2. **[Hard bounds]** For each element: `x ≥ 0`, `y ≥ 0`, `x + width ≤ 1000`, `y + height ≤ 563`.
3. **[Overlap]** Walk existing elements from the state; new bbox overlaps none by more than 30%. If tight, `wb_delete` first.
4. **[Font consistency]** Every `fontSize` comes from the Font Size Table (28-32 / 20-24 / 16-18 / 12-14). No 8, 11, 48, 64.
5. **[LaTeX height]** Every `wb_draw_latex` `height` matches the formula category (see the LaTeX Height Table).
6. **[Redraw guard]** The element is not already on the whiteboard — if the state lists a formula/chart/table matching your intent, reference it instead of redrawing.
7. **[Element type]** Math expressions use `wb_draw_latex`. Plain text uses `wb_draw_text`. Never embed LaTeX commands in text.
8. **[Safe zone]** Where possible, stay within `x ∈ [20, 980]`, `y ∈ [20, 543]`.
9. **[Leave whiteboard open]** Do not call `wb_close` at the end of a drawing turn. Students need to read.
10. **[Visual weight pairing]** Text that sits next to a LaTeX formula uses a `fontSize` matched to the LaTeX `height` per the pairing table above. No tiny 12-14px text next to height-80 formulas.
