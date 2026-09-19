---
name: slide-craft
title: "页面设计"
description: The design law of a slide page — canvas geometry, the text height table, the type scale, contrast pairs, spacing rhythm, and which element type carries which content. Load it when patching slide elements one at a time, when a fix is about colour or contrast, when text has to grow or shrink inside a box, when a page feels crowded or empty, or when replacement content needs real rich-text structure. It is the standard `page-clone` and `pro-editing` edit against, not a procedure of its own — those two decide which pages to touch and in what order, this one decides what a good page looks like when you put it back.
---

# The design law of a slide page

Every slide in this runtime was drawn under a long set of rules — the canvas,
the height table, the type scale, the spacing standards. The generator that
drew the page had all of them in front of it. When you patch one element, you
have the page's numbers and nothing else, and the rules are the only way to
tell a repair from a dent.

This is that rule set, restated for editing. It is about the page, not the
process: which numbers a change has to stay consistent with, and which fields
actually reach the screen.

## The canvas you are editing inside

The canvas is **1000 × 562.5**. All elements respect a **50px margin**, so the
live area is `left ∈ [50, 950]`, `top ∈ [50, 512.5]`, and an element's right
edge (`left + width`) stays ≤ 950, its bottom edge ≤ 512.5.

The page's own alignment grid, which existing elements are already on:

- Left-aligned content sits at `left = 60` or `left = 80`.
- Centred content is `left = (1000 - width) / 2` — recomputed, never guessed.
- Right-aligned content is `left = 1000 - width - 60`.

Changing `width` on centred content changes `left` too, and they are two separate
writes. Read the neighbours' boxes first and land on the column they are already
using; a lone element 8px off the shared left edge reads as a mistake even though
nothing overflows.

**There is no alignment operation.** Every position is an explicit number you
write to that element's own `left` / `top` / `width` / `height`, one path per call,
computed from the neighbours you read. Aligning a row means giving each element the
number the row already uses — not asking the page to tidy itself.

## Text is sized by table, not by eye

A text element has **10px padding on all four sides**, so its usable area is
`(width - 20) × (height - 20)`, and heights come from one table
(line-height 1.5, padding included):

| Font size | 1 line | 2 lines | 3 lines | 4 lines | 5 lines |
| --------- | ------ | ------- | ------- | ------- | ------- |
| 14px      | 43     | 64      | 85      | 106     | 127     |
| 16px      | 46     | 70      | 94      | 118     | 142     |
| 18px      | 49     | 76      | 103     | 130     | 157     |
| 20px      | 52     | 82      | 112     | 142     | 172     |
| 24px      | 58     | 94      | 130     | 166     | 202     |
| 28px      | 64     | 106     | 148     | 190     | 232     |
| 32px      | 70     | 118     | 166     | 214     | 262     |
| 36px      | 76     | 130     | 184     | 238     | 292     |

When you replace an element's words, re-derive its height instead of keeping
the old one:

1. `characters_per_line = (width - 20) / font_size`. Keep the longest line at
   **≤ 75%** of that; past 100% the text wraps and takes a row you did not
   budget.
2. Count the lines your new content needs — one per `<p>`, plus a wrap for
   every paragraph over `characters_per_line` — then add ~0.8 of a line of
   slack and round up.
3. Look the height up against the **largest font size present in the
   content**, not the average.

Height is a container, not a clamp: overflowing text spills past the box
rather than shrinking, and the page shows the spill. The fix order is
**shorten the words, then step to the next table row, then widen the box** —
in that order, because a slide that needs a bigger box usually needs fewer
words.

## The type scale

| Content     | Size    |
| ----------- | ------- |
| Main title  | 32-36px |
| Subtitle    | 24-28px |
| Key points  | 18-20px |
| Body        | 16-18px |
| Caption     | 14-16px |

Levels stay 2-4px apart and everything at one level uses one size. When you
touch an element, take its size from the siblings that share its role on that
page rather than from this table fresh — the page's own scale wins, and this
table is how you recognise which level an element belongs to.

**Size lives in the content HTML**, as inline `font-size` on the `<p>` — there is
no font-size field to write. So changing a size means writing the whole content
string back, which means you have to know the markup you are replacing.

## What the renderer really does with your HTML

The `content` of a text element is an HTML string, and this page's CSS resets
most tag semantics. Four consequences decide how you write rich text:

- **`<ul>` / `<ol>` render without markers.** The stylesheet's reset strips
  `list-style` and the indent, and the rule that puts them back is scoped to
  the browser editor — not to classroom playback. A list sent as
  `<ul><li>…</li></ul>` comes out as bare unindented lines. Write bullets the
  way the deck itself does: **one `<p>` per item with the marker in the text**,
  `<p style="font-size:18px;">• First point</p>`.
- **`<h1>`–`<h6>` are inert.** The reset sets `font-size: inherit` and
  `font-weight: inherit` on them, so a heading tag is a `<p>` with extra
  characters. Size and weight come from inline `font-size` and
  `<strong>`, which do work.
- **Stacked `<p>` tags have no gap between them** in a text element — only
  line-height separates them. If two lines need air between them, raise the
  element's `lineHeight` or split them into two elements; do not expect an
  empty `<p>`, whose height still costs you a table row.
- **A newline in plain text is not a line break.** Plain text is wrapped in a
  single `<p>` and the newline collapses to a space. Multi-line content must
  arrive as real `<p>` tags, one per line.

Anything that looks like a tag is passed through as markup and not escaped, so
prose containing `<` followed by a letter (`if x<y> then`) is read as HTML and
mangled. Send that as an escaped entity.

Supported inline styles are `font-size`, `color`, `text-align`, `line-height`,
`font-weight` and `font-family`; supported tags are `<p>`, `<span>`,
`<strong>`/`<b>`, `<em>`/`<i>`, `<u>`. Nothing else is a contract.

## Contrast is a pair, never a colour

Before you change any colour, name the two things that will sit on top of each
other. Text is legible or not against **its immediate backdrop**, which is the
shape's `fill` if it sits on a shape, the text element's own `fill` if it has
one, and the page background otherwise.

Which field carries which colour:

| Ink                   | Field                            |
| --------------------- | -------------------------------- |
| Text element glyphs   | `defaultColor`, or inline `color` in the content |
| Text element backdrop | `fill` (unset = the page shows through) |
| Shape label glyphs    | `text.defaultColor`              |
| Shape body            | `fill`                           |
| Formula               | `color` on the latex element     |
| Rule / arrow          | `color` on the line element      |

A colour change is one write to the field the renderer actually reads —
`defaultColor` or the inline `color` inside the content for text,
`text.defaultColor` for a shape label, `color` for a latex or line element. Read
the source JSON first and preserve its inline spans. `opacity` on a text element fades the glyphs
*and* the fill together because it applies to the whole box — it is not a way
to soften a background behind live text.

Aim for **≥ 4.5:1** on body text and **≥ 3:1** on 24px-and-up titles. Two
calibration points from this deck's own palette: `#333333` on white is about
12:1 and safe anywhere; the accent `#5b9bd5` on white is about 3:1, which
passes for a 32px title and fails for 16px body. The pattern that always
works here is a **pale tint fill with dark same-hue text** — `#1e40af` on
`#dbeafe`, `#166534` on `#dcfce7`, `#92400e` on `#fef3c7`, each around 6-7:1.
Recolouring one half of such a pair breaks it; recolour both or neither.

## Text on a shape is one object

A label inside a card is not an independent element — its box is derived from
the shape's:

```
text.width  = shape.width - 40            (20px padding each side)
text.height = a table value ≤ shape.height - 40
text.left   = shape.left + (shape.width  - text.width)  / 2
text.top    = shape.top  + (shape.height - text.height) / 2
```

Centre points should agree within 2px. So moving the shape is always two edits —
move the shape, then re-derive the label — and a text height that steps up to the
next table row may force the card to grow with it. The classic
wrong repair is giving the label the shape's own `left`/`top`, which pins it
to the top-left corner instead of centring it.

## Rhythm, in exact numbers

Parallel things use **identical** values, not close ones: three cards in a row
share one `width`, one `height`, one `top`, and one gap. The eye resolves 5px,
so approximation is visible. When you delete one card of a row or duplicate one
into it, respace **all** of them from the row's own arithmetic rather than
dropping the newcomer next to its neighbour.

The spacing standards the page was built to:

- Title → subtitle 30-40px; title → body 35-50px; between paragraph blocks
  20-30px; text ↔ image 25-35px vertically, 30-40px horizontally.
- Multi-column gap 40-60px. Any gap crossed by a connector arrow needs
  **60-80px**, or the arrowhead lands inside the neighbouring box.
- Nothing closer than 50px to a canvas edge.

**Diagnosing density from the inventory.** The boxes tell you the truth
without a render: sort the content elements by `top` and read the gaps.
A crowded page shows gaps under ~20px and a bottom edge near 512; an empty one
shows one cluster and 150px of dead space below it. Fix crowding by cutting
words and merging elements, not by shrinking font sizes below the scale — a
page whose body text has dropped to 12px is a page with too much content on
it. Fix emptiness by growing the type one level and re-centring the block
vertically, not by adding filler.

## One kind of content, one kind of element

The page has ten element types and they are not interchangeable. Getting this
wrong is the failure that renders as literal source code on a slide.

- **Any mathematics is a latex element.** LaTeX syntax inside a text element or
  a table cell renders as the raw string — the learner reads `\frac{a}{b}`.
  This holds for the small ones too (`x^2`, `a/b`).
- **A latex element's rendered form is cached.** Write the new source to that
  element's `latex` and the server re-renders the cached `html` the renderer
  actually paints. Verify the result with a preview.
- **Table cells are plain text.** No formulas, no markup.
- **A code element takes plain lines**, split on newlines, and renders as a
  fixed light card with its own border and title bar — it cannot be themed to a
  dark page. Its default text size is 14px, and its height must cover a 32px
  header plus every line.
- **A line element's `width` is stroke thickness, not length.** Length comes
  from `start`/`end`. Keep stroke at 2-4 (never above 6): the arrowhead is
  `width × 3` across, so `width: 60` draws a 180px arrowhead.
- **Images keep their aspect ratio.** Change `width` and `height` together;
  writing a new `src` does not touch the box, so an image of a different shape
  needs the box re-derived.

## Derived elements follow their anchor

Underlines, dividers and highlight bars are shapes whose geometry was computed
from the text they decorate. Move or resize the text and they do not follow —
recompute them:

- **Title underline**: `left = text.left + 10`, `width = text.width - 20`,
  `top = text.top + text.height + 8..12`, `height = 2..4`.
- **Section divider**: `width` 700-900, `height` 1-2, with 25-35px of clear
  space above and below.
- **Highlight bar**: `left = text.left - 15`, `top = text.top + 0.1 ×
  text.height`, `height = 0.8 × text.height`, `width` 3-6.

An orphaned rule floating beside moved text is one of the most visible signs of
a careless patch.

## Depth is array order

Elements paint in array order; later ones sit on top. Background shapes come
before the text they hold. When something is hidden behind something else, the fix
is to rewrite the element array in the order you want — never move a box to escape
the overlap, and never delete the backdrop.

## After the patch

Check only the elements you touched, and check these:

1. Inside the margins — `left`/`top` ≥ 50, right and bottom edges ≤ 950 /
   512.5.
2. Height is a table value for the largest font size in the content, and the
   longest line is under 75% of `characters_per_line`.
3. Every colour you changed still forms a legible pair with what is behind it.
4. Text-on-shape pairs still centre within 2px; parallel elements still share
   exact values.
5. Any decorative shape anchored to something you moved has moved with it.
6. No LaTeX, and no raw markup, sitting inside text or table content.
7. The words still read like a slide — keywords and short phrases, under ~20
   words or ~30 Chinese characters per line, no spoken sentences, and no text
   attributed to the teacher by name or role. Prose that wants to be spoken
   belongs in the page's narration, not on the page.

Where a preview is available, spend it on the changes this list cannot settle:
a formula, a density judgement, or text you suspect overflows.

## Where this sits

- **`slide-dsl`** is the field reference under this one — every element type's
  fields, which of them holds the words, what values are legal, and what the
  renderer actually does with each of them. It says what you *may* write; this skill says
  what is *worth* writing. Load it when you need a field name or a legal value.
- **`page-clone`** is the procedure for building a page out of an existing
  one. It decides which elements are content and which are skeleton; this skill
  decides whether the content you put in them is well made.
- **`pro-editing`** is the procedure for revising a page that already exists —
  which operation to reach for, how small to keep it, how to verify. This skill
  is what "well made" means once that operation lands.
- **`stage-design`** still governs the build of the stage as a whole.

## Hard rules

- **Nothing inside 50px of an edge, ever** — recompute the number, do not nudge.
- **Heights come from the table**, recomputed after every text change.
- **Colour is a pair.** Never change one side of a text/backdrop pair alone;
  patch the renderer-owned colour field shown above.
- **Real HTML for real structure** — `<p>` per line, bullet characters instead
  of `<ul>`, inline `font-size` instead of heading tags.
- **Formulas are latex elements, and their rendered form does not follow a
  string patch.** Replace, do not patch.
- **Parallel elements share exact numbers.** Copy them from the inventory.
- **Cut words before you grow boxes.** A page that only fits at 12px is a page
  with too much on it.
