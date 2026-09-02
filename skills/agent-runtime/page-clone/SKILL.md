---
name: page-clone
title: "页面克隆"
description: Building one page that looks like a page the course already has — copy the model page with `duplicate_scene`, then rewrite the copy's words with one `patch_stage` op per content slot. Use when a new page has to inherit an existing page's design, whether the model page came from an imported deck or the course wrote it earlier. Not for revising a page that is already the page you want (that is `pro-editing`), and not for the course-level work of cataloguing layouts and assigning one per outline entry (that is `style-clone`).
---

# Cloning one page's design

The design already exists on another page. Your job is to put **new content into
that design** without redrawing it: copy the page, then swap what it says.

Copy-then-edit is the only clone path in this runtime. `generate_scene` always
re-rolls a page from its outline entry — the model invents a fresh element tree
every time — so calling it on a copied page destroys exactly the design you came
for. Nothing here validates the shape of your result either: the design is
preserved because you copied it, and the judgement about which elements are
content and which are the skeleton is yours.

## The sequence

1. **`duplicate_scene({ templateSceneId, targetOrder, title })`** — an exact copy
   of the model page at the position you want (`templateOrder` works too, but an
   id is safer). The copy carries the full content, no narration actions, and a
   new outline entry. Pass a `title` that names the NEW page; the entry inherits
   the model page's brief, and a copy still called 「第 3 章回顾」 misleads both
   the learner and the narration step.
2. **Read the copy with `read_stage`, `path:/scenes/<order|id>`,
   `detail:"source"`** — this is your address space
   and your fidelity source. It returns the whole page's persisted JSON, including
   raw content HTML, inline spans, fonts, colours, fills, shadows, geometry and
   z-order, and it is the root your patch paths are written against: a field you
   read at `/content/canvas/elements/2/content` is written back through that same path.
   Copy unchanged markup and style fields from this result; do not reconstruct
   them from stripped text.
3. **Decide, element by element, what each one is.** Content slots are the ones
   whose words belong to the old subject. Skeleton is everything else — rules,
   bands, page numbers, logos, decorative shapes, background art — and it stays
   untouched even when it holds text.
4. **Call `patch_stage` once per content slot**, with `op:"set"` on the exact
   path that holds that slot's words — `/content/canvas/elements/3/content` for a
   paragraph, `/content/canvas/elements/5/data/0/0/text` for a table cell. One leaf per
   call: everything you do not name keeps the value you copied. `slide-dsl` is the
   manual for which field holds the words in each element type. Do not patch
   geometry or style paths while cloning — they ARE the design you copied.
5. **Read the copy with `read_stage detail:"text"`** after the
   edits. It returns every
   text-bearing element as `{ path, id, type, text }` plus a page-wide
   `combinedText`, so you read the whole page's words in one call and get the
   pointer to fix with them. Search it for source-topic residue; the read reports,
   and you decide what is stale, then `set`, `remove`, or `delete_element` it.
6. **`generate_actions` on the copy** to give it narration (audio is on by
   default). A duplicated page arrives silent.

Work one page at a time and re-read before you edit. Every `patch_stage` result
already carries the page's fresh inventory, so a run of edits on the same page
needs one `read_stage` call at the start, not one
per call.

## Where a change goes

For a cloned slide, `patch_stage` uses `set`, `remove`, `str_replace`,
`add_element`, and `delete_element`; for cloning the usual choice is `set` on
the smallest content leaf. The only question is **which path** carries the change.

| Need                         | Call                                                        | What really happens                                                                                                        |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| New words in a text block    | `set` `/content/canvas/elements/N/content`                     | Stores your HTML byte for byte — nothing filters it; preserve the source element's `<span>` marks and inline styles while changing the words |
| New words in a shape's label | `set` `/content/canvas/elements/N/text/content`                 | Only the label's HTML moves; font, colour, vertical alignment, line height, shape fill and path all stay                    |
| One table cell               | `set` `/content/canvas/elements/N/data/0/0/text`                | One cell's plain text; every other cell, id, `colspan`, `rowspan` and per-cell style is untouched                           |
| One line of code             | `set` `/content/canvas/elements/N/lines/1/content`              | One line's text, with every line id kept — language, filename, font size and box survive                                    |
| A formula                    | `set` `/content/canvas/elements/N/latex`                        | Replaces the source and re-renders the cached KaTeX `html` the renderer actually paints                                     |
| A chart label or number      | `set` `/content/canvas/elements/N/data/labels/2`                | One entry; keep `labels`, `legends` and `series` dimensionally consistent                                                   |
| A different image            | `set` `/content/canvas/elements/N/src`                          | Points the element at another source. It never creates a picture — get a real `src` from `generate_image` first, and keep the original rather than invent a URL |
| Nudge a box                  | `set` `/content/canvas/elements/N/left` (or `top` / `width` / `height`) | One number at a time. On a cloned page this is a repair, not a step                                              |
| Drop an optional field       | `remove` `/content/canvas/elements/N/fill`                      | Deletes that key. `remove` on a path that is not there fails, and so does removing a required field                         |
| One content slot too many    | `delete_element` (`elementId`)                                | Removes the element and any animation bound to it                                                                          |
| A genuinely new element      | `add_element` (complete element JSON, **no `id`**)            | Validates every field and rich-text value, assigns the id, inserts at `afterId` or `index`                                  |
| Restack overlapping elements | `set` `/content/canvas/elements`                                | The only change with no leaf — write the array whole, reordered, with the same ids and types                                |
| Rename the page              | `edit_deck retitle`                                          | Title only, in both the deck and the outline entry                                                                         |

Three properties make this safe to lean on, and all three are worth knowing before
you do: **only the path you name changes**, **identity is not patchable** (the id
set and each id's type must come back identical, which is why adding or removing
an element has its own op), and **a rejected patch changes nothing** — a bad path,
an unknown field, unsafe HTML or an invalid result fails loud with the page as it
was. Nothing normalises your colours or fonts toward a house style either, which is
the property that makes a copied design survive editing at all.

The content rule is simple: **source HTML in, source HTML out**. Change the text
inside the returned paragraphs and spans; do not flatten the block to plain text
or synthesize fresh styling. For lists, keep one `<p>` per item with the marker
in the text (`slide-craft` explains why `<ul>` does not render its markers here).

When a cloned page needs one more slot, the cheapest honest source is an element
already on it: read its JSON and `add_element` a copy with the words and box you
want. `add_element` is full fidelity, so its caller supplies every geometry and
style field — which is why an existing element is a better starting point than a
blank one, and why this is the last resort rather than a step.

## When the new content does not fit the layout

This is the normal case, not an error: a layout with three bullet slots and
content with seven points is a mismatch you resolve, and no tool will resolve it
for you. In order of preference:

1. **Cut the content to the layout's capacity.** A borrowed layout is a statement
   about how much can be said on one page. Tightening the expression preserves the
   design; growing the page destroys it.
2. **Split across two clones.** Duplicate the model page again and carry the
   remainder onto the second copy. Two pages in the deck's own form beat one
   overstuffed page.
3. **Pick a roomier model page.** If the course has a layout built for more
   content, clone that one and abandon this copy (`edit_deck delete`).
4. **Grow the layout, only as a last resort** — `add_element` a copy of the
   closest content element, with its box set into the rhythm of the ones around it
   (match their left edge and spacing exactly, taken from the source boxes) and
   the new words already in it. You are now drawing, and it shows if you are careless.

Fewer content slots than the layout has is the easier direction: fill what you
can meaningfully fill and `delete_element` the rest. **Never leave a template's words
standing on the page.** A slot you neither replaced nor deleted is a bug — the
old subject leaking into the new one — and a `detail:"text"` read
with `read_stage detail:"text"` is the sweep
that catches it before shipping.

## Overflow discipline

Text sized for the model page's words is not sized for yours. Aim for the same
order of magnitude as the text you replaced — that length was chosen for that
box, and it is the only sizing information you have. When your replacement runs
much longer, shorten the wording rather than resizing the box.

Verify with `render_scene_preview` when it is registered, and spend the calls
where they buy something: the **first page you clone from a given model page**,
and any later clone whose text is visibly longer than what it replaced. Skip it
otherwise; previews cost calls. If a page overflows, load `pro-editing` and
   converge inside its budget of two preview rounds — shorten text first, and set a
box only when the text is already tight. If two rounds have not converged, move the
content to a roomier layout or name the page to the user. Do not ship a page with
text running off it.

## Finish the page

`generate_actions` on the copy, with a `styleDirective` when the surrounding
pages have a register worth matching. Narration is written from the page's
persisted content plus its outline entry, and that entry's brief came from the
model page — so the content you just wrote has to be unambiguous on its own, and
the title has to be the new page's title. Then read the result back
with `read_stage detail:"source"` and check both halves
of the result: every speech action carries an `audioId`, and every speech line is
about **this** page's subject rather than the model page's — a narrated wrap-up or
a topic name inherited from the brief is residue exactly as template words on the
slide are. Repair it with `patch_stage` on that action's `/actions/N/text`
pointer, then `generate_tts` the page
so the audio matches the words.

## Where this sits

- **`style-clone`** governs the course-level job: reading an imported deck as a
  library of layouts, classifying them, and assigning one to each outline entry.
  It calls into this skill for the per-page mechanics.
- **`slide-dsl`** is the field manual for the JSON you are patching — the ten
  element types, which field holds the words in each, what values are legal, and
  what the renderer really does with the HTML you write. Load it when you are about to patch a
  field you have not patched before, or when a patch comes back rejected.
- **`pro-editing`** governs editing a page that is already the page you want.
  Load it when a clone comes out wrong, and follow its preview budget.
- **`slide-craft`** is the design law the replacement content has to satisfy —
  the height table, the type scale, contrast pairs, how rich text really renders.
  Load it when a slot needs more than a like-for-like sentence swap.
- **`stage-design`** still governs the build of the stage as a whole.

## Hard rules

- **Copy, then edit. Never `generate_scene` on a copied page.** It re-rolls the
  element tree from the outline entry and the borrowed design is gone.
- **Content changes; design does not.** No geometry path, no style path, no new
  element and no restacking while cloning, unless the layout genuinely has to grow
  and you have read the neighbouring boxes first.
- **Every element ends up replaced, deliberately kept, or deleted.** No template
  words survive by accident.
- **Always run the text sweep.** `read_stage detail:"text"` returns every
  element's words plus one `combinedText`; read all of it, and fix what it turns
  up at the `path` it hands you. The read reports — it never decides or edits.
- **Facts do not travel with the layout.** Text carried over from the model page
  is a claim in its new context; if it belongs to the old subject, it goes.
- **One page at a time.** `duplicate_scene`, then that page's edits, then its
  actions — then the next page. Each write persists as it lands.
