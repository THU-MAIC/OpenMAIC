---
name: slide-dsl
title: "页面数据结构"
description: The complete slide DSL manual — the canvas and its background, the ten element types field by field with units, defaults and legal values, where each type keeps its words, which field the renderer actually paints when two disagree, exactly what happens to the HTML you put in `content`, and the structure schema that is now the ONLY thing a write is checked against. Nothing filters your markup and nothing normalises your values, so this manual is the whole of what makes a page render correctly. Load it before patching a field you have not patched before, when a patch comes back rejected, when a patch lands but nothing moves on screen, or when you need to know where a colour, a font, a table cell or a code line really lives. This is a field reference and not a procedure — `page-clone` and `pro-editing` decide which pages to touch, `slide-craft` decides what a good page looks like, and this one says what the JSON means.
---

# The slide DSL

A slide page is a JSON document. Editing it well means writing the exact field
that holds the thing you want to change, in the exact shape the renderer reads,
and leaving every neighbouring field byte-identical.

**Read this part first, because it changes how you should use everything below.**
The write path stores what you send. There is no markup allow-list, no
sanitizer, no colour or font normalisation, no geometry clamping, no house style
applied on the way in. `patch_stage` checks one thing — that the resulting
document still matches the DSL **structure** schema (field names, types, required
fields, closed objects) — and then persists your value byte for byte.

So there is nothing between you and the screen. A structurally legal page can
still be an unreadable page: markup the renderer never styles, a colour on a
field nothing paints, a formula snapshot that disagrees with its source. The
guard rail catches shape, not meaning. **This manual is the meaning.** Where it
tells you how the renderer behaves, that is the whole of your knowledge — write
against it, then read the page back and check what you wrote is what is there.

## Contents

1. [Reading before writing](#reading-before-writing) — the three read depths
2. [The document](#the-document) — `content` → `canvas`
3. [The canvas](#the-canvas) — viewport, theme, background, animations, paint order
4. [How an edit reaches the JSON](#how-an-edit-reaches-the-json) — three ops, pointer rules
5. [What the structure schema refuses](#what-the-structure-schema-refuses) — the only hard boundary
6. [Two renderers paint your page](#two-renderers-paint-your-page) — playback vs. preview
7. [Fields every element carries](#fields-every-element-carries)
8. [The ten element types](#the-ten-element-types) — one section each
9. [The rendering truth of `content` HTML](#the-rendering-truth-of-content-html) — the most important section
10. [Quick reference](#quick-reference) — one row per element type
11. [Where this sits](#where-this-sits)
12. [Hard rules](#hard-rules)

## Reading before writing

`read_stage` has three depths — `detail:"tree"`, `detail:"source"` and
`detail:"text"` — and they are not interchangeable.

| `detail`        | What comes back                                                                                              | Use it for                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `inventory` (default) | One compact line per element — `id`, `type`, plain-text `text`, `left`, `top`, `width`, `height`, `src` | Finding an element. **Never** as a patch source.  |
| `source`        | The exact persisted page JSON — the root every patch path is written against                                   | Every patch. Read it again after a write.         |
| `text`          | Every text-bearing element as `{ path, id, type, text }` plus one page-wide `combinedText`                     | Proving old copy left no residue.                 |

- **`inventory` strips the markup.** Its `text` is the element's HTML with tags
  replaced by spaces and whitespace collapsed. A patch built from it invents
  style values that were never there and deletes the ones that were.
- **`source` always returns the whole page.** There is no per-element
  projection, so array indices cannot drift between what you read and what you
  write. It returns the full `content` object — `type`, `schemaVersion` and the
  complete `canvas`, background, theme and animations included.
- **`detail:"text"` gives you pointers.** Each `path` is that element's own
  `/content/canvas/elements/N`, so a residue check hands you the pointer to fix. Note
  that its `text` for a `latex` element is the LaTeX source, for `code` the
  lines joined by newlines, and for `table` the cells joined by ` | `.

## The document

A slide scene's `content` is:

```
{ type: 'slide', schemaVersion?: number, canvas: Slide }
```

`type` and `schemaVersion` sit **outside** `/content/canvas/` and are therefore not
reachable by a slide-canvas patch path — such a pointer begins `/content/canvas/`. Everything you can
write lives under `canvas`.

## The canvas

| Field           | Required | Meaning                                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`            | yes      | Page identity. Changing it is rejected.                                                     |
| `viewportSize`  | yes      | Canvas **width in px** — **1000** in this product                                           |
| `viewportRatio` | yes      | Height ÷ width — **0.5625**, so the canvas is **1000 × 562.5 px**                            |
| `theme`         | yes      | `backgroundColor`, `themeColors[]`, `fontColor`, `fontName`, optional `outline` / `shadow`   |
| `elements`      | yes      | The element array, **in paint order** — index 0 is the bottom of the stack                  |
| `background`    | no       | Page background — see below                                                                 |
| `animations`    | no       | Per-element animation records                                                               |
| `turningMode`   | no       | `no` / `fade` / `slideX` / `slideY` / `random` / `slideX3D` / `slideY3D` / `rotate` / `scaleY` / `scaleX` / `scale` / `scaleReverse` |
| `sectionTag`    | no       | `{ id, title? }`                                                                            |
| `type`          | no       | `cover` / `contents` / `transition` / `content` / `end`                                      |
| `script`        | no       | Speaker notes carried in from a `.pptx` import                                              |

**All of them are patchable.** `/content/canvas/theme/fontColor`, `/content/canvas/background/color`,
`/content/canvas/animations/0/duration` are ordinary pointer paths. The only two writes the
identity guard blocks are changing `/content/canvas/id` and changing an element's `id` or
`type`. Optional branches can be created wholesale — `set` on `/content/canvas/background`
adds the object; `remove` deletes it again.

### Geometry — what a pixel means

`viewportSize` is the design-space width, not a screen width. Every element's
`left` / `top` / `width` / `height` is in those same design pixels, origin at the
**top-left** of the canvas, x to the right and y downwards. At render time the
whole canvas is scaled by one factor to fit its container, so design pixels are
proportions in disguise — a `width: 500` element is always half the page wide.

Useful constants for the standard page:

- Canvas: `0 ≤ left ≤ 1000`, `0 ≤ top ≤ 562.5`
- Horizontal centre: `left = (1000 - width) / 2`
- Vertical centre: `top = (562.5 - height) / 2`
- Nothing clips at the canvas edge in the DOM, but anything outside the box is
  cropped in a snapshot/export capture, so off-canvas geometry is a bug.

### `background`

`{ type, color?, image?, gradient? }`. `type` is `solid` | `image` | `gradient`.

The renderer resolves it in a fixed order, and **a type whose payload is missing
falls through to plain white `#fff`**, not to another payload you left behind:

| `type`     | Reads                              | Result                                                                                                       |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `solid`    | `color`                            | `background-color: color`. `color` missing → transparent, i.e. the shell shows through.                        |
| `image`    | `image { src, size }`              | `size: 'repeat'` → `background-repeat: repeat` + `background-size: contain`; `cover` / `contain` → no-repeat with that size. `image` or `image.src` missing → `#fff`. |
| `gradient` | `gradient { type, colors[], rotate }` | `type: 'linear'` → `linear-gradient({rotate}deg, …)`; `'radial'` → `radial-gradient(…)`, and **`rotate` is ignored for radial**. `gradient` missing → `#fff`. |
| absent     | —                                  | `#fff`                                                                                                        |

`gradient.colors` is `[{ pos, color }, …]` where `pos` is a **percentage number**
(`0`–`100`, written without the `%`) and `color` any CSS colour. `rotate` is
degrees.

Setting `background.color` while `type` is still `'gradient'` changes nothing you
can see. **The `type` field is the selector; the payload fields are inert unless
`type` names them.**

### `theme`

`{ backgroundColor, themeColors[], fontColor, fontName, outline?, shadow? }` —
all four scalars required.

What the renderer actually does with it: **only `fontColor` and `fontName` are
painted.** They are set on the wrapper around every element, so they are the
inherited default for any glyph whose own element and inline styles do not
override them. `theme.backgroundColor` is **not** the page background (that is
`canvas.background`); `theme.themeColors`, `theme.outline` and `theme.shadow` are
authoring defaults consumed by the editor when it creates new elements, not by
the renderer.

### `animations`

`[{ id, elId, effect, type, duration, trigger }, …]`, `type` one of `in` / `out` /
`attention`, `trigger` one of `click` / `meantime` / `auto`.

**Nothing plays them in playback.** Neither renderer reads `canvas.animations`;
the only consumer is the Pro-mode editor's animation panel. They are stored,
validated and preserved — treat them as data you must not destroy, never as a way
to make something move on a learner's screen. Deleting an element deletes the
animations bound to its id for you.

### `elements` is the z-order

Depth is array position: index 0 paints first (bottom), the last element paints
last (top). There is no `zIndex` field, and the renderer assigns the CSS
`z-index` from the array index itself. This is the one change with no leaf to
address — see the restacking note below.

## How an edit reaches the JSON

For slide canvases, `patch_stage` exposes five operations.

| Op               | Arguments                                                | What it does                                          |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `set`            | `path`, `value`                                          | Writes one JSON Pointer path in the persisted scene   |
| `remove`         | `path`                                                   | Removes one optional field or bounded array item      |
| `str_replace`    | `path`, `oldText`, `newText`, optional `replaceAll`       | Replaces an exact anchor inside one string field      |
| `add_element`    | `element` (complete, **no `id`**), `afterId` or `index`  | Inserts one new element; the server assigns its id    |
| `delete_element` | `elementId`                                              | Removes that element and any animation bound to it    |

- `set` without `value` fails; `remove` **with** a `value` fails.
- `add_element` refuses an `element` that carries an `id` — identity is the
  server's. It takes `afterId` **or** `index`, never both; `index` must be an
  integer from `0` to the current element count; omit both and the element lands
  on top.
- Creating an element is a full-element write, not a patch — every DSL-required
  field for that type must be present (the [type sections](#the-ten-element-types)
  mark them).

### Addressing a field

`path` is a JSON Pointer rooted at the exact scene returned by `read_stage
detail:"source"`, so a slide field begins `/content/canvas/`. A field you read at
`/content/canvas/elements/2/left` is written
back through that same path.

- **Address the leaf, not the branch.** Give the smallest path that isolates the
  change. Writing a whole object back is how a neighbouring style field gets
  silently dropped.
- **Array indices are canonical and bounded.** `0`, `1`, `2` — `03`, `-1`, `+1`
  and an index past the end are all rejected.
- **Every segment before the last must already exist.** The last one need not:
  `set` on a key the object does not have yet **adds that optional field** (giving
  a text element a `fill`, a shape a `text`), and `remove` deletes it again.
  `remove` on a path that is not there fails.
- **A path may not cross a scalar.** `/content/canvas/elements/0/content/0` fails because
  `content` is a string, not a container.
- **`remove` on an array index splices** the array shorter. There is no insert-at-index
  for arrays other than rewriting the array whole.
- `~1` and `~0` escape `/` and `~` inside a key. A bare `~` or `~2` is rejected.
- The value is deep-cloned on the way in, so a nested object you send is stored
  as its own tree.

Worked examples, one call each:

| Change                    | `path`                                | `value`                                            |
| ------------------------- | ------------------------------------- | -------------------------------------------------- |
| A title's rich text       | `/content/canvas/elements/0/content`          | `<p><span style="color:#00a870">新标题</span></p>` |
| One table cell            | `/content/canvas/elements/5/data/0/0/text`    | `"净利润"`                                         |
| One line of code          | `/content/canvas/elements/9/lines/1/content`  | `"total = price * count"`                            |
| A shape's label           | `/content/canvas/elements/3/text/content`     | `<p>第二阶段</p>`                                  |
| A glyph colour default    | `/content/canvas/elements/2/defaultColor`     | `"#1f4e79"`                                        |
| One chart label           | `/content/canvas/elements/6/data/labels/2`    | `"Q3"`                                             |
| An element's position     | `/content/canvas/elements/2/left`             | `120`                                              |
| The page background       | `/content/canvas/background/color`            | `"#f7f7f5"`                                        |
| Drop an optional field    | `/content/canvas/elements/4/shadow`           | (`op: 'remove'`)                                |
| Restacking                | `/content/canvas/elements`                    | the whole array, reordered                          |

Z-order has no leaf to address, because paint order **is** array position. Write
`/content/canvas/elements` whole, carrying every element back unchanged in a new order —
the id set and every id→type pairing has to come back identical.

## What the structure schema refuses

This is the whole of the enforcement, and **a rejected write changes nothing** —
an error is information, not damage. Every check below runs before anything is
stored, and the error message names the offending path.

**Pointer-level refusals**

1. A slide-canvas path that does not begin `/content/canvas/`.
2. A malformed `~` escape.
3. A non-canonical array index (`03`, `-1`) or one out of bounds.
4. A missing intermediate segment, or a path that crosses a non-container.
5. `remove` on a key or index that is not there.
6. `set` without `value`, or `remove` carrying one.

**Identity refusals** (checked on the result of the write)

7. Changing `/content/canvas/id`.
8. Adding, removing, renaming or duplicating an element `id` — that is what
   `add_element` and `delete_element` are for.
9. Changing an existing id's `type`. Turning a text element into a shape is a
   delete plus an add.
10. `add_element` with an `id` in the element, or with both `afterId` and `index`.

**Schema refusals** (the whole canvas is re-validated, at every nesting level)

11. An **unknown field** anywhere — every object in the contract is closed
    (`additionalProperties: false`). A misspelt `defaultFontname` does not land as
    a stray key; it fails the call.
12. A **wrong type** — a string where a number belongs, a number where a string
    belongs, an object where an array belongs.
13. A value outside a **closed union** — `style: 'double'` on a line, a
    `chartType` that is not one of the eight, an `align` that is not in its set.
14. A **required field removed** — `remove` on `/content/canvas/elements/0/content`, on a
    table's `colWidths`, on `viewportSize`, on any `theme` scalar.
15. A **tuple of the wrong arity** — `viewBox` must be exactly two numbers,
    `points` exactly two markers, `clip.range` exactly two pairs.
16. A field on the wrong type — `latex` on a text element, `content` on an image.

That list is exhaustive for the write path. Notice what is **not** on it: no tag
check, no CSS check, no colour-format check, no length limit, no geometry bound,
no contrast rule, no check that `html` agrees with `latex`, no check that a chart's
`series` matches its `labels`. Those are all yours to get right.

**The one thing the server rewrites for you**: when a patch changes an element's
`latex`, the server re-renders that element's `html` snapshot from the new source
(KaTeX, display mode, errors rendered rather than thrown) and stores it. If the
render returns nothing, `html` is removed instead. Nothing else in the document is
touched, ever.

## Two renderers paint your page

The same JSON is drawn by two different implementations, and knowing which is
which explains most "it looks right in one place and wrong in another" reports.

| | **Playback renderer** | **Preview renderer** |
| --- | --- | --- |
| Code | the in-app element components (`components/slide-renderer/components/element/*`, mounted by `components/slide-renderer/Editor/ScreenElement.tsx`) | `@openmaic/renderer`'s `SlideCanvas` |
| Where it runs | the classroom page the learner watches — **the default** | page thumbnails (`components/slide-renderer/SlideThumbnail.tsx`), and playback too when `NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED` is on (off by default) |
| Stylesheet for rich text | **none** — only the global CSS reset, browser defaults, and your inline styles | ships its own `.slide-renderer-prose` rules with the canvas |

They agree on every field that matters most (geometry, fills, precedence,
`html`-over-`latex`). Where they differ, this manual says so, and the rule is
always the same: **write for the intersection.** The known divergences are

- **list markers** — restored by the preview renderer's stylesheet, absent in
  playback (see [the HTML section](#the-rendering-truth-of-content-html));
- **`paragraphSpace` on a text element** — honoured by the preview renderer, inert
  in playback;
- **`vAlign` on a text element and `vAlign` / `padding` / `borders` on a table
  cell** — honoured by the preview renderer, ignored in playback;
- **a plain-text `content` with newlines** — the preview renderer sets
  `white-space: pre-line` when the string contains no markup at all, so the
  newlines become line breaks; playback does not, so they collapse to spaces;
- **`audio` elements** — drawn as a click-to-play button by the preview renderer,
  **not rendered at all** in playback;
- **an oversized formula** — the preview renderer only ever shrinks a formula to
  fit its box, playback also enlarges it to fill the box.

## Fields every element carries

`id`, `left`, `top`, `width`, `height`, `rotate` — all required — plus optional
`lock`, `groupId`, `link { type, target }` and `name`.

- `left` / `top` / `width` / `height` are canvas px, origin top-left. `rotate` is
  degrees, clockwise, about the box centre.
- **A `line` element is the exception**: it has no `height` and no `rotate`,
  because its extent and direction come from its endpoints. Patching either onto a
  line is an unknown-field rejection.
- `lock`, `groupId` and `name` are editor bookkeeping — no renderer reads them.
  Preserve them; do not expect them to change a pixel.
- `link` is likewise **not painted by either renderer**. An element-level
  hyperlink is stored and exported, not clickable in playback.
- Rotation is applied to a wrapper *inside* the positioned box, so `left` / `top` /
  `width` / `height` always describe the **unrotated** box. To reason about the
  visual bounds of a rotated element you have to rotate the rectangle yourself.

## The ten element types

`text` · `shape` · `image` · `line` · `chart` · `table` · `latex` · `video` ·
`audio` · `code`. They are not interchangeable, and the field that holds an
element's words is different in every one of them.

### text

**Required**: `content` (HTML string), `defaultFontName`, `defaultColor`, plus the
common geometry.

| Optional field   | Type / values                    | Default when absent | What the renderer does with it                                                |
| ---------------- | -------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `fill`           | colour string                    | none                | Background colour of the box — painted on the **declared** `height` only       |
| `outline`        | `{ style?, width?, color? }`     | none                | A rectangular SVG stroke at the box bounds                                     |
| `lineHeight`     | number (multiplier)              | `1.5`               | `line-height` on the content box                                               |
| `wordSpace`      | number (px)                      | `0`                 | `letter-spacing` on the content box                                            |
| `paragraphSpace` | number (px)                      | `5`                 | **Playback ignores it** (see below); the preview renderer uses it as the `<p>` bottom margin |
| `opacity`        | number `0`–`1`                   | `1`                 | Opacity of the whole box including `fill`                                      |
| `shadow`         | `{ h, v, blur, color }`          | none                | `text-shadow` on the glyphs                                                    |
| `vertical`       | boolean                          | `false`             | `writing-mode: vertical-rl`, and swaps which of width/height is auto            |
| `vAlign`         | `top` / `middle` / `bottom`      | `top`               | Preview renderer only — vertical anchor inside the box. **Inert in playback**   |
| `textType`       | `title` / `subtitle` / `content` / `item` / `itemTitle` / `notes` / `header` / `footer` / `partNumber` / `itemNumber` | none | Authoring metadata. **No renderer reads it** |

Words live in **`content`**.

**The four things that go wrong here**

1. **`defaultColor` and `defaultFontName` are only defaults.** They are set on the
   container, so any inline `color` / `font-family` inside `content` wins by ordinary
   inheritance. An element whose paragraphs carry `color:#C00000` does not change
   colour when you patch `defaultColor`. Change the inline span, or change both.
2. **The box has 10 px of padding on all four sides**, so the usable text area is
   `(width - 20) × (height - 20)`.
3. **`height` does not clip.** The content box is auto-height inside a fixed-height
   frame with visible overflow, so text longer than the box **spills out** and can
   land on top of the element below it. The `fill` colour and the `outline` stop at
   the declared `height`, which is what makes the overflow obvious once you look.
   Text that no longer fits needs a smaller `font-size` or a bigger `height`, not a
   hope that it will be cropped.
4. **`paragraphSpace` is inert in playback.** Playback sets it as a CSS variable
   that no rule reads, so stacked `<p>` tags sit with zero gap. If you need
   breathing room between paragraphs in playback, put `margin-bottom` in the `<p>`'s
   own inline style.

### shape

**Required**: `viewBox` `[w, h]`, `path` (an SVG `d`), `fixedRatio`, `fill`, plus
the common geometry.

| Optional field | Type / values                                   | What the renderer does with it                                            |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `gradient`     | `{ type, colors[{pos,color}], rotate }`         | An SVG gradient used as the path's fill                                    |
| `pattern`      | image URL string                                | An SVG image pattern used as the path's fill                               |
| `outline`      | `{ style?, width?, color? }`                    | The path's stroke, non-scaling                                             |
| `opacity`      | number `0`–`1`                                  | Opacity of the shape and its label together                                |
| `flipH` / `flipV` | boolean                                      | Mirrors the path (the label is counter-mirrored so glyphs stay upright)     |
| `shadow`       | `{ h, v, blur, color }`                         | `drop-shadow` filter                                                       |
| `text`         | `ShapeText`                                     | The label — see below                                                      |
| `special`      | boolean                                         | Marks a path the exporter cannot express; no visual effect                 |
| `pathFormula`  | one of 21 named formulas                        | Recomputes `path` on resize instead of scaling it                          |
| `keypoints`    | number[]                                        | Adjustment handles for a `pathFormula` shape                               |
| `fixedRatio`   | boolean                                         | Editor resize constraint; no visual effect                                 |

**Fill precedence: `pattern` beats `gradient` beats `fill`.** The renderer picks the
first one present, in that order. Patching `fill` on a shape that carries a
`gradient` changes nothing you can see — remove the loser first, or patch the
winner.

**Geometry.** `path` is in `viewBox` coordinates; the renderer scales it by
`width / viewBox[0]` and `height / viewBox[1]`. So resizing a shape means patching
`width` / `height` and leaving `viewBox` and `path` alone — unless the shape has a
`pathFormula`, in which case the path is recomputed from it. **Never hand-edit
`path` to resize a shape.**

**Words live in `text.content`** — a nested `ShapeText`:

| `text` field    | Required | Default | Notes                                                                 |
| --------------- | -------- | ------- | --------------------------------------------------------------------- |
| `content`       | yes      | —       | HTML string, same rules as a text element's `content`                  |
| `defaultFontName` | yes    | —       | Inherited default, beaten by inline styles                             |
| `defaultColor`  | yes      | —       | Same                                                                   |
| `align`         | yes      | —       | `top` / `middle` / `bottom` — the **vertical** anchor, not horizontal   |
| `lineHeight`    | no       | `1.625` | Multiplier                                                             |
| `wordSpace`     | no       | `0`     | px                                                                     |
| `paragraphSpace`| no       | `5`     | px — **honoured in playback here**, unlike on a text element            |
| `type`          | no       | —       | Same authoring metadata as `textType`; unread by renderers              |

A shape with no `text` object has no words at all; giving it one means supplying
the whole object (`content`, `defaultFontName`, `defaultColor`, `align` are all
required). Horizontal alignment comes from `text-align` inside the HTML, never from
`align`. The label sits inside 10 px of padding in playback and flush to the box
edges in the preview renderer — keep a margin of your own if a tight fit matters.

### image

**Required**: `src`, `fixedRatio`, plus the common geometry. No words.

| Optional field | Type / values                                   | What the renderer does with it                                                        |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `outline`      | `{ style?, width?, color? }`                    | An SVG stroke shaped to the clip (rect / ellipse / polygon)                             |
| `filters`      | `{ blur?, brightness?, contrast?, grayscale?, saturate?, 'hue-rotate'?, sepia?, invert?, opacity? }` | CSS `filter` — each value is a **string with its unit**, e.g. `"4px"`, `"120%"`, `"90deg"` |
| `clip`         | `{ range: [[x1,y1],[x2,y2]], shape }`           | `range` is in **percent** of the original picture; `shape` is a named clip path          |
| `radius`       | number (px)                                     | Corner radius — **only takes effect when `clip.shape` is a rect-type shape**             |
| `flipH` / `flipV` | boolean                                      | Mirrors the picture                                                                     |
| `shadow`       | `{ h, v, blur, color }`                         | `drop-shadow` filter                                                                    |
| `colorMask`    | colour string                                   | A flat colour layer painted over the picture — an opaque value hides the picture entirely |
| `softEdge`     | number (px)                                     | Preview renderer only — feathers the edges. **Inert in playback**                        |
| `imageType`    | `pageFigure` / `itemFigure` / `background`       | Authoring metadata. **No renderer reads it**                                            |
| `fixedRatio`   | boolean                                         | Editor resize constraint; no visual effect                                              |

`clip.shape` is one of `rect`, `rect2`, `rect3`, `roundRect`, `ellipse`, `triangle`,
`triangle2`, `triangle3`, `rhombus`, `pentagon`, `hexagon`, `heptagon`, `octagon`,
`chevron`, `point`, `arrow`, `parallelogram`, `parallelogram2`, `trapezoid`,
`trapezoid2`. A name outside that set resolves to nothing and the picture disappears.

**`src` is the pitfall.** Anything matching `http:`, `https:`, `data:`, `blob:`, `/`
or `./` is treated as a concrete address and rendered directly. **Anything else is
treated as a generation placeholder** and the element renders a skeleton, an error
box or a disabled badge instead of a picture, depending on whether a generation task
exists for that reference. Writing a made-up id into `src` therefore does not show a
picture — it shows a placeholder forever. A real picture comes from the image
generation tool, whose returned reference you then store.

Swapping `src` does not touch the box, so a picture with a different aspect ratio
needs `width` and `height` re-derived together.

### line

**Required**: `start` `[x, y]`, `end` `[x, y]`, `style`, `color`, `points`, plus
`left`, `top` and `width`. **No `height` and no `rotate`.** No words.

| Field      | Type / values                              | Meaning                                                                 |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| `start`    | `[x, y]`                                   | Start point, **relative to `left` / `top`** — normally `[0, 0]`           |
| `end`      | `[x, y]`                                   | End point, same origin — the vector `end - start` is the line             |
| `width`    | number (px)                                | **Stroke thickness, not length.** Length comes from the endpoints         |
| `style`    | `solid` / `dashed` / `dotted`              | Dash pattern is derived from `width`, so a thick dashed line has long dashes |
| `color`    | colour string                              | Stroke and marker colour                                                 |
| `points`   | `[start, end]`, each `''` / `'arrow'` / `'dot'` | End markers. `''` means none. Marker size is `max(width, 2) × 3` px    |
| `shadow`   | `{ h, v, blur, color }`                    | `drop-shadow` filter                                                     |
| `broken`   | `[x, y]`                                   | One elbow — path becomes `start → point → end`                            |
| `broken2`  | `[x, y]`                                   | Two elbows, orientation chosen from which span is longer                  |
| `curve`    | `[x, y]`                                   | Quadratic control point                                                  |
| `cubic`    | `[[x1,y1],[x2,y2]]`                        | Two cubic control points                                                 |

The control points are checked in the order `broken`, `broken2`, `curve`, `cubic`
and **the first one present wins** — leaving a stale `curve` behind while adding a
`broken` means the curve is silently ignored. Remove the loser.

Moving a line means patching `left` / `top`; changing its direction or length means
patching `start` / `end`.

### chart

**Required**: `chartType`, `data`, `themeColors[]`, plus the common geometry.

| Field        | Type / values                                                     | Notes                                                        |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `chartType`  | `bar` / `column` / `line` / `pie` / `ring` / `area` / `radar` / `scatter` | See the shape table below                              |
| `data`       | `{ labels: string[], legends: string[], series: number[][] }`       | The whole dataset                                            |
| `themeColors`| string[]                                                          | Series palette, in order                                     |
| `options`    | `{ lineSmooth?, stack? }`                                          | `lineSmooth` for `line` / `area`; `stack` for `bar` / `column` / `line` / `area` |
| `fill`       | colour string                                                     | Background of the chart box                                  |
| `outline`    | `{ style?, width?, color? }`                                       | A rectangular stroke at the box bounds                       |
| `textColor`  | colour string                                                     | Axis labels, legend text and data labels                     |
| `lineColor`  | colour string                                                     | Grid split lines                                             |

Words live in **`data.labels[]`** and **`data.legends[]`**; numbers live in
**`data.series[][]`** — one `series` row per legend, one entry per label. Relabelling
is therefore usually one path for the label and one for its matching series entry
(`/content/canvas/elements/N/data/labels/2`), not a rewrite of `data`.

How each type reads that dataset:

| `chartType` | Orientation / shape                       | `labels` are…                | `series` are…                                             |
| ----------- | ----------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| `bar`       | **Vertical** columns (category on x)      | the x-axis categories        | one row per legend                                         |
| `column`    | **Horizontal** bars (category on y)       | the y-axis categories        | one row per legend                                         |
| `line`      | Line chart                                | the x-axis categories        | one row per legend                                         |
| `area`      | Line chart with the area filled           | the x-axis categories        | one row per legend                                         |
| `pie`       | Pie, radius 70%                           | the slice names              | **only `series[0]` is used** — one value per label          |
| `ring`      | Donut, radii 40%–70%                      | the slice names              | **only `series[0]` is used**                               |
| `radar`     | Radar                                     | the spoke names              | one polygon per legend                                     |
| `scatter`   | Scatter                                   | unused                       | **`series[0]` is x, `series[1]` is y**; with no `series[1]`, y = x |

The two that catch people out: **`bar` is the vertical one and `column` is the
horizontal one** — the names are the opposite way round from the shape; and
`scatter` reads two series as coordinate arrays rather than as two data sets.

Two more renderer facts: the legend is only drawn when there is **more than one
series** (pie and ring always draw one), and a chart whose `series` is missing or
empty **renders nothing at all** — an empty box, not an empty axis.

### table

**Required**: `colWidths[]`, `cellMinHeight`, `outline`, `data`, plus the common
geometry.

| Field           | Type / values                                                        | Notes                                                                        |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `colWidths`     | number[]                                                             | **Ratios that sum to 1.** Column px = `colWidths[i] × element width`          |
| `cellMinHeight` | number (px)                                                          | Row height fallback; content taller than it still expands the row             |
| `rowHeights`    | number[] (optional)                                                  | Per-row height, overriding `cellMinHeight` for that row                       |
| `outline`       | `{ style?, width?, color? }`                                         | The uniform grid border. Missing `width` → **1 px**, missing `color` → **black** |
| `theme`         | `{ color, rowHeader, rowFooter, colHeader, colFooter }` (optional)    | Banding — see below                                                          |
| `data`          | `TableCell[][]`                                                      | Row-major grid                                                               |

A cell is `{ id, colspan, rowspan, text, style?, padding?, vAlign?, borders? }`.
`id`, `colspan`, `rowspan` and `text` are **all required** — a normal cell is
`colspan: 1, rowspan: 1`. `style` may carry `bold`, `em`, `underline`,
`strikethrough`, `color`, `backcolor`, `fontsize` (a **string with its unit**),
`fontname`, `align` (`left` / `center` / `right` / `justify`).

Words live in **`data[row][col].text`**. One cell is one path:
`/content/canvas/elements/5/data/0/0/text`. Address the cell's `text` and never the row or
the grid, and every id, `colspan`, `rowspan` and per-cell style around it survives
untouched — a `colspan` you drop takes the table's shape with it.

**Cell text is its own dialect.** Playback runs the cell's `text` through a
transform before injecting it as HTML: every `\n` becomes `<br/>` and **every space
becomes `&nbsp;`**. That has three consequences you must design around:

1. `\n` in a cell **is** a line break — the one place in the DSL where a raw newline
   renders.
2. **Inline `style` attributes inside a cell do not work.** `style="color: red"`
   becomes `style="color:&nbsp;red"`, which is not a valid declaration, so the colour
   is dropped. Same for any attribute value with a space in it, and for a
   two-class `class`. Cell appearance comes from `cell.style`, not from markup.
3. Text with spaces will **not wrap** at those spaces. Long prose in a cell
   overflows sideways instead of re-flowing.

So: put plain text in a cell, use `\n` for breaks, use `cell.style` for appearance,
and reach for attribute-free tags (`<strong>`, `<br/>`) only if you must. The preview
renderer skips the space transform, which is exactly why a cell that looks fine in a
thumbnail can look wrong in playback.

**`theme` banding**, when present: `rowHeader` paints row 0 in `theme.color` with
white text; `rowFooter` does the same to the last row; `colHeader` / `colFooter`
paint the first / last column in `theme.color` at 30 % alpha; every other even row
gets it at 10 %. A cell's own `style.backcolor` and `style.color` beat all of it.

**Fields playback ignores** (preview renderer honours them): `cell.vAlign` —
playback always centres vertically; `cell.padding` — playback always uses 5 px;
`cell.borders` — playback always draws the table-level `outline` on all four sides.

**Merged cells are fragile.** Both renderers expect `data[r]` to contain only the
top-left cell of each merge, with the spanned positions absent, and playback's
hidden-cell computation compares data indices against grid coordinates — which
mis-hides a cell in tables with mixed spans. Prefer un-merged tables; if you inherit
merges, change only `text` and never the span numbers.

### latex

**Required**: `latex` (the source), plus the common geometry.

| Field        | Type / values                  | Notes                                                                 |
| ------------ | ------------------------------ | --------------------------------------------------------------------- |
| `latex`      | string                         | The source. Required                                                   |
| `html`       | string                         | The KaTeX snapshot — **this is what the renderer paints**               |
| `align`      | `left` / `center` / `right`    | Horizontal placement inside the box, default `center`                  |
| `color`      | colour string                  | Applied to the container; KaTeX glyphs inherit it                      |
| `path`       | SVG `d` string                 | Legacy fallback, used only with `viewBox` and only when `html` is absent |
| `viewBox`    | `[w, h]`                       | Legacy fallback, same condition                                        |
| `strokeWidth`| number                         | Legacy fallback stroke width                                           |
| `fixedRatio` | boolean                        | Editor resize constraint; no visual effect                             |

**`html` beats `latex`.** The renderer paints `html` if it is there, falls back to
`path` + `viewBox` only when `html` is absent (**both** must be present or nothing
renders at all), and never reads `latex` directly. So the two must not disagree:

- **Patch `latex` and let the server re-render `html` for you.** That is the one
  automatic rewrite in the whole write path, and it is why changing the formula
  through `latex` is the correct move.
- A patch that sets `html` yourself is taken as authoritative and nothing
  re-renders over it. Setting `html` alone leaves a formula whose source lies.
- Invalid LaTeX does not fail the patch. KaTeX is called with errors rendered rather
  than thrown, so a typo becomes **visible red error text on the slide**.

Sizing: `width` and `height` are the frame; the rendered formula is measured and
scaled to fit inside both. Playback also scales a small formula **up** to fill the
box, so an oversized frame around a short formula renders it huge; the preview
renderer only ever shrinks. Size the box to the formula.

### code

**Required**: `language`, `lines[]`, plus the common geometry.

| Field            | Type / values         | Default | Notes                                                    |
| ---------------- | --------------------- | ------- | -------------------------------------------------------- |
| `language`       | string                | —       | Highlighting key — see the supported set below            |
| `lines`          | `{ id, content }[]`   | —       | One entry per line, **no trailing newlines**               |
| `fileName`       | string                | none    | A small title above the code                              |
| `showLineNumbers`| boolean               | `true`  | Gutter numbers                                            |
| `fontSize`       | number (px)           | `14`    | Code font size                                            |

Words live in **`lines[].content`**, one path per line —
`/content/canvas/elements/9/lines/1/content` — which leaves every other line's `id`
untouched. `content` is **plain text**: it is HTML-escaped before rendering, so `<`,
`>` and `&` show as themselves and markup in a code line is displayed, not applied.

Removing a line splices the array; adding one means writing `lines` whole, and only
`add_element` mints ids, so an inserted line needs an `id` you choose that does not
collide (the convention is `L1`, `L2`, …). Keep the existing ids exactly — they are
what the typing animation and the per-line diff key off.

Highlighting is loaded for a fixed set of languages — `python`, `javascript`,
`typescript`, `json`, `go`, `rust`, `java`, `c`, `cpp`, `html`, `css`, `bash`, `sql`,
`yaml`, `markdown`, `jsx`, `tsx`. **Any other value renders as unhighlighted plain
text** rather than failing, so `language: "py"` silently loses colour where
`"python"` keeps it.

### video

**Required**: `autoplay`, plus the common geometry — and a source, which is either
`src` or `mediaRef`. No teaching text.

| Field      | Type / values | Notes                                                                       |
| ---------- | ------------- | --------------------------------------------------------------------------- |
| `src`      | string        | A concrete URL, or a generation placeholder resolved the same way as an image's |
| `mediaRef` | string        | A generated-video reference                                                  |
| `autoplay` | boolean       | Required by the schema and **ignored by playback** — a video waits for an explicit play action |
| `poster`   | string        | Preview frame; a generated task's own poster wins over this one               |
| `ext`      | string        | Names the format when the URL carries no extension                            |

A concrete `src` wins; otherwise `mediaRef` (or a non-concrete `src`) is treated as a
generation reference and the element shows a skeleton or an error box until that
generation lands.

### audio

**Required**: `src`, `fixedRatio`, `color`, `loop`, `autoplay`, plus the common
geometry. Optional `ext`. No teaching text.

**Playback does not render audio elements at all** — the element type is simply not
in playback's dispatch table, so the element occupies its box invisibly. The preview
renderer draws a click-to-play speaker button, honours `loop`, and does **not** honour
`autoplay` there either.

Do not use an audio element to make a page speak. A page's spoken narration is the
scene's actions, not an element.

## The rendering truth of `content` HTML

This section applies to a text element's `content` and a shape's `text.content`.
(A table cell's `text` is a different dialect — see [table](#table). A code line is
plain escaped text — see [code](#code).)

### What actually happens to your string

The string you store is injected into the page as raw HTML — the renderer sets it as
the container's inner HTML and hands the rest to the browser. **Nothing parses it,
filters it, rewrites it or validates it on the way in or on the way out.** What that
means concretely:

1. **The write is byte-exact.** Read the element back after a patch and you get the
   same bytes you sent. If the page looks wrong, the bytes are wrong — the fix is a
   new patch, not a retry.
2. **There is no tag allow-list and no CSS property allow-list.** Any tag the HTML
   parser accepts is in the DOM; any declaration the browser understands takes
   effect. You are not writing for a filter, you are writing for a browser.
3. **In playback there is no stylesheet for this HTML at all.** No author rules
   target the injected content. Its appearance is decided by exactly four things,
   in cascade order: the global CSS reset, browser defaults the reset does not
   override, styles inherited from the element container (`defaultColor`,
   `defaultFontName`, `lineHeight`, `wordSpace`, `writing-mode`), and **your own
   inline styles**, which beat everything above them.
4. **Which means an inline style always wins.** The reset uses no `!important`, so
   any declaration in a `style` attribute overrides it. That is the lever for
   anything the reset has flattened.

### The global reset — what it flattens

The app's CSS reset zeroes `margin`, `padding` and `border` on **every** element, and
then makes these specific changes. This is the single biggest source of "my markup
did nothing":

| Markup            | After the reset                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `<h1>`–`<h6>`     | **Inert.** `font-size: inherit`, `font-weight: inherit` — a heading is a `<p>` with a longer name |
| `<ul>` / `<ol>`   | `list-style: none` **and** zero padding — **no marker, no indent**                              |
| `<li>`            | Still `display: list-item`, but with no marker to show                                          |
| `<blockquote>`    | No margin, no padding, no border — a plain block                                                |
| `<p>`             | No margin — stacked paragraphs touch, with **zero gap**                                          |
| `<a>`             | `color: inherit`, `text-decoration: inherit` — **looks exactly like body text**                  |
| `<table>`         | `border-collapse: collapse`, no borders                                                        |
| `<img>` / `<video>` | `display: block`, `max-width: 100%`, `height: auto`                                           |

And these keep working, because the reset either sets them deliberately or leaves the
browser default alone:

| Markup             | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `<strong>` / `<b>` | `font-weight: bolder` — bold against a normal-weight parent                  |
| `<em>` / `<i>`     | Italic                                                                       |
| `<u>`              | Underline                                                                    |
| `<s>` / `<strike>` / `<del>` | Line-through                                                       |
| `<sub>` / `<sup>`  | 75 % size, shifted, and **kept out of the line height** by the reset          |
| `<small>`          | 80 % size                                                                    |
| `<mark>`           | The browser's highlight — yellow background, **and it forces black text**      |
| `<code>` / `<pre>` | Monospace at `1em`. `<pre>` also **preserves whitespace and newlines**         |
| `<br>`             | A line break                                                                 |
| `<span>` / `<div>` | Nothing of their own — pure carriers for your inline styles                   |

**The list case, spelled out.** `<ul><li>甲</li><li>乙</li></ul>` renders in playback
as two bare, unindented lines. The preview renderer restores markers with its own
stylesheet, so the same page shows bullets in a thumbnail and none in the
classroom — that divergence is the reset, not a bug in your JSON. Two ways out, and
`slide-craft` prefers the first:

- Write one `<p>` per item with the marker in the text (`<p>· 甲</p>`), which renders
  identically everywhere.
- Or force the list back with inline style on the `<ul>` itself:
  `<ul style="list-style: disc inside">`. Inline beats the reset, and `inside` keeps
  the marker within the padding box where zeroed padding would otherwise leave an
  `outside` marker flush against the edge. *This follows from the cascade; it has not
  been checked against a rendered page.*

### Inline CSS — there is no property list, only a cascade

Because the HTML goes straight into the DOM, **every valid CSS property in a `style`
attribute is applied by the browser.** The useful question is not "is this property
supported" but "does anything override it, and does the layout give it room". The
properties you will actually reach for, and what to expect:

| Property                                  | Behaviour                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `color`                                   | Applied. Beats `defaultColor`, which is only the inherited container value                     |
| `font-family`                             | Applied. Beats `defaultFontName`. Give a fallback stack; an unavailable face silently substitutes |
| `font-size`                               | Applied. **Use px** — see the export note below                                                |
| `font-weight`                             | Applied. Prefer the literal `bold` over `700` — see the export note                            |
| `font-style`, `text-decoration`           | Applied                                                                                       |
| `line-height`                             | Applied on the tag that carries it; beats the element's `lineHeight`                            |
| `letter-spacing`                          | Applied; beats the element's `wordSpace`                                                       |
| `text-align`                              | Applied — this is the **only** horizontal alignment control. Neither element has a field for it |
| `margin`, `margin-bottom`, `padding`      | Applied, and the only way to get paragraph spacing in playback                                  |
| `text-indent`                             | Applied                                                                                       |
| `background-color`                        | Applied — a highlight behind a run of text                                                     |
| `white-space` (`pre-wrap`, `pre-line`)    | Applied — the way to make newlines inside a tag render as breaks                                |
| `list-style`, `padding-inline-start`      | Applied, and needed to undo the reset on a list                                                 |
| `opacity`, `text-transform`, `vertical-align` | Applied                                                                                    |
| `display`, `position`, `width`, `height`, `overflow` | Applied. They work, and they are also how a page ends up with content clipped or stacked where you did not intend |
| `background` with a gradient, `-webkit-text-fill-color`, `mask-image` | Applied by the browser. Effective in playback; **not reproduced by the PPTX export** |

**Colour formats.** Any CSS colour works — `#rgb`, `#rrggbb`, `#rrggbbaa`,
`rgb()`, `rgba()`, `hsl()`, and the named colours. The renderer never parses colour
strings for `content`; the browser does. For consistency with the rest of the page,
match whatever notation the element you are editing already uses. (Element-level
colour *fields* — `defaultColor`, `fill`, a line's `color`, a cell's `color` — are
also passed through untouched, with one exception: the PPTX export converts them.)

### What happens to markup the renderer does not know

- **An unknown tag** (`<foo>bar</foo>`) is parsed into the DOM as an inline element
  with no styling. Its text still shows; the tag contributes nothing.
- **An unknown or misspelt attribute** is kept in the DOM and ignored. There is no
  error and no visible effect.
- **A malformed nesting** is silently repaired by the HTML parser, which can move
  nodes. Your bytes are preserved exactly, but the tree the browser builds may not be
  the tree you wrote — `<p><div>x</p></div>` is the classic way to get layout you did
  not ask for. Write well-formed markup.
- **`<script>` set through inner HTML never executes** — the browser does not run
  scripts inserted this way. Inline event-handler attributes are a different matter
  and do become live handlers. Neither is a rendering mechanism; a slide should
  contain no script and no handlers, and the snapshot and export pipelines would not
  carry them anyway.
- **An `<img>` inside `content`** renders through the same reset rules as any picture.
  Whether an external host is reachable under the page's content-security policy is
  *not verified here* — use an `image` element, which has a resolution path built for
  it.

### The PPTX export reads a much shorter list

Playback is not the only consumer. The user-facing "export to PPTX" path is the one
place that genuinely **parses** your HTML and maps it onto PowerPoint runs, and it
understands a fixed set:

- **Consumed**: `font-size` (parsed as px, converted to pt), `color`,
  `background-color` (becomes a highlight), `text-decoration` /
  `text-decoration-line` (underline, line-through), `vertical-align` (`super` /
  `sub`), `text-align`, `font-weight`, `font-style`, `font-family`; the tags `<em>`,
  `<strong>`, `<sup>`, `<sub>`, `<a href>`, `<ul>`, `<ol>`, `<li>`, `<br>`; block
  breaks after `<div>`, `<li>`, `<p>`; and `data-indent` on a `<p>`.
- **Not consumed**: `line-height`, `letter-spacing`, `white-space`, `margin` /
  `padding`, `text-indent`, `opacity`, `text-transform`, gradients, masks, and every
  other property. They render on screen and vanish in the exported deck.
- Two sharp edges: `font-weight` becomes bold **only for the literal string `bold`**,
  so `font-weight: 700` exports as normal weight; and `font-size` is read with an
  integer parse, so `1.5em` is read as `1`. **Write `font-size` in px and
  `font-weight: bold`.**

### Write-is-what-you-store

There is no filter to catch a mistake and no normaliser to tidy one. So the loop is:

1. Read `detail:"source"` and copy the element's existing markup shape — same tags,
   same style attributes, same notation — changing only what you mean to change.
2. Write one leaf path.
3. Read it back and compare. If the bytes are not what you sent, the patch was
   rejected, and a rejected patch changed nothing.
4. If the bytes are right and the page still looks wrong, the bytes are wrong: come
   back to this section, not to the tool.

## Quick reference

`N` is the element's index in `/content/canvas/elements`.

| Type      | Words live in            | Appearance lives in                                  | Geometry                                              | Three most common patch paths                                                                  |
| --------- | ------------------------ | ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `text`    | `content` (HTML)         | inline styles in `content` > `defaultColor` / `defaultFontName` / `lineHeight` / `wordSpace` / `fill` | `left` `top` `width` `height` `rotate`  | `…/N/content` · `…/N/defaultColor` · `…/N/height`                                              |
| `shape`   | `text.content` (HTML)    | `pattern` > `gradient` > `fill`; label via `text.*`   | `left` `top` `width` `height` `rotate` (+ `viewBox`, `path`) | `…/N/text/content` · `…/N/fill` · `…/N/text/defaultColor`                                |
| `image`   | — none                   | `filters` `clip` `radius` `colorMask` `outline`       | `left` `top` `width` `height` `rotate`                | `…/N/src` · `…/N/width` · `…/N/clip/range`                                                     |
| `line`    | — none                   | `color` `style` `width` (thickness) `points`          | `left` `top` `start` `end` (**no** `height`/`rotate`)  | `…/N/end` · `…/N/color` · `…/N/points/1`                                                       |
| `chart`   | `data.labels[]`, `data.legends[]` | `themeColors` `textColor` `lineColor` `fill`  | `left` `top` `width` `height` `rotate`                | `…/N/data/labels/2` · `…/N/data/series/0/2` · `…/N/chartType`                                  |
| `table`   | `data[r][c].text` (plain) | `data[r][c].style.*` · `theme` · `outline`           | `left` `top` `width` `height` `rotate` (+ `colWidths`) | `…/N/data/0/0/text` · `…/N/data/0/0/style/color` · `…/N/colWidths`                              |
| `latex`   | `latex` (source)         | `align` `color`; **`html` is what paints**             | `left` `top` `width` `height` `rotate`                | `…/N/latex` · `…/N/align` · `…/N/width`                                                        |
| `code`    | `lines[].content` (plain) | `language` `fontSize` `showLineNumbers` `fileName`   | `left` `top` `width` `height` `rotate`                | `…/N/lines/1/content` · `…/N/language` · `…/N/fontSize`                                        |
| `video`   | — none                   | `poster`                                             | `left` `top` `width` `height` `rotate`                | `…/N/src` · `…/N/poster` · `…/N/width`                                                         |
| `audio`   | — none                   | `color` (**invisible in playback**)                   | `left` `top` `width` `height` `rotate`                | `…/N/src` · `…/N/loop` · `…/N/left`                                                            |

Page-level paths worth remembering: `/content/canvas/background/color`,
`/content/canvas/background/gradient/colors/0/color`, `/content/canvas/theme/fontColor`,
`/content/canvas/elements` (restacking).

**The precedence rules, in one place.** Patching the loser changes nothing visible:

- `pattern` > `gradient` > `fill` on a shape
- `html` > `path` + `viewBox` on a formula, and `latex` is never painted directly
- `background.type` selects which of `color` / `image` / `gradient` is read
- a line's first present control point among `broken` > `broken2` > `curve` > `cubic`
- inline styles in `content` > the element's `defaultColor` / `defaultFontName` /
  `lineHeight` / `wordSpace` > the canvas `theme.fontColor` / `fontName`
- a table cell's own `style.backcolor` / `style.color` > the table `theme` banding

## Where this sits

- **`slide-craft`** is the design law — canvas margins, the text-height table, the
  type scale, contrast pairs, spacing rhythm, and which element type should carry
  which content. This manual says what a field is called, what it may hold and what
  the renderer does with it; that one says what value makes the page good.
- **`page-clone`** and **`pro-editing`** are the procedures that call the edit tools —
  which pages to touch, in what order, how to verify. This manual is the contract of
  the JSON those calls carry.
- **`style-clone`** is the course-level mode that copies a deck's layouts, and it
  leans on this reference for every content rewrite.

## Hard rules

- **Patch paths come from `detail:"source"`, never from the compact read.** The
  compact read has no styles to preserve and no pointers to give you.
- **Address the leaf.** One field per call, the smallest path that isolates it.
- **Restacking rewrites `/content/canvas/elements` whole**, and has to return the same ids
  with the same types.
- **The words live in a different field in every type.** `content`, `text.content`,
  `data[row][col].text`, `lines[].content`, `data.labels[]`. Find it in the source
  JSON; do not guess it.
- **Nothing filters your markup and nothing normalises your values.** The structure
  schema is the only check. Everything about how a page *looks* is your
  responsibility and this manual's subject.
- **Patch the winner, not the loser.** Check the precedence table before concluding a
  field is broken.
- **A rejected patch changed nothing.** Read the message, fix the path, retry.
- **Read the page back after every write.** That is the only proof that what you
  meant is what is stored.
