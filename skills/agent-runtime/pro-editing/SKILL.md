---
name: pro-editing
title: "专业编辑"
description: Professional editing of a course that already exists. Use when the user wants to revise, improve, restructure or polish pages the course already has — fix a page, tune a layout, repair a quiz, reword narration, reorder the deck, or raise the quality of the whole course. Not for building a new course from scratch.
---

# Professional course editing

You are editing a **persisted course**, not generating one. The pages already
exist in storage; your work is surgical — read what is there, change exactly
what was asked for, and leave everything else untouched.

## Enter the course before touching it

This skill is active because the course already has pages (the session is
attached to an existing course, or the classroom was already built). Before
any edit:

1. Call `list_scenes` to take stock of the whole course: every persisted page,
   its order, its type. This list — not your assumption — is the map you edit
   by.
2. Do not plan a replacement stage. The course has a structure; you are not
   replanning it.
3. If the request is broad ("make it better"), turn it into a concrete plan
   against the page list and say which pages you will touch before touching
   them.

## Read before every change

Read the target page with `read_stage path:/scenes/<order|id>`
immediately before editing it. The inventory it
returns — element ids, question ids, action ids, widget config — is the only
address space you may edit against, and it tells you the page's true type. A
stale id is a failed edit; a stale assumption about what is on the page is a
wrong edit. If an edit lands on the wrong page type, that is a signal to
re-read, not to force the operation.

`read_stage` has three levels, and a slide edit uses the deep one. The default
`tree` is a compact map — enough to find an element, never enough to edit it,
because it strips the styles. Before any slide write, read the page with
**`detail:"source"`**: it returns the page's exact persisted JSON (all style
fields, raw content HTML with inline marks and line breaks, exact geometry,
z-order), and it is the root your patch paths address — a field read at
`/content/canvas/elements/2/left` is written back through that same path. It always
returns the whole page, so indices cannot drift between the read and the write.
**`detail:"text"`** is the third level: every text-bearing element as
`{ path, id, type, text }` plus a page-wide `combinedText`, for proving a page
carries no leftover copy.

## Choose the smallest operation

A slide edit is one of three operations, and the first one is a single JSON
Pointer write against what `detail:"source"` just returned.

| User intent                                     | Tool                             | Operation                                                                        |
| ----------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Fix or rewrite text on a slide                  | `patch_stage` | `set` or `str_replace` on that element's content path — `/content/canvas/elements/N/content`, `…/text/content`, `…/data/0/0/text`, `…/lines/1/content`, `…/latex` |
| Move / resize / rotate an element, fix overlap  | `patch_stage` | `set` on `/content/canvas/elements/N/left` (or `top` / `width` / `height` / `rotate`), one number per op |
| Recolor or restyle an element                   | `patch_stage` | `set` on the renderer-owned style path — `…/defaultColor`, `…/fill`, `…/text/defaultColor`, `…/color` |
| Drop an optional field                          | `patch_stage` | `remove` on that path                                                             |
| Swap an image or media source                   | `patch_stage` | `set` on `/content/canvas/elements/N/src`                                         |
| Restack slide elements                          | `patch_stage` | `set` on `/content/canvas/elements` — the whole array, reordered, same ids and types |
| Add or remove a slide element                   | `patch_stage` | `add_element` (complete JSON, no `id`) / `delete_element`                         |
| Fix quiz questions, options, answers, scoring   | `patch_stage` | `set` / `remove` against `/content/questions/...`; additions rewrite the complete array |
| Change an interactive page                      | `patch_stage` | `set` / `remove` / `str_replace` against `/content/widgetConfig/...` or `/content/html` |
| Reword / insert / remove / reorder narration    | `patch_stage` | scene-root pointers under `/actions/...`; rewrite a complete array for insertion/reorder |
| Edit a PBL brief, roles, milestones, microtasks | `patch_stage` | `set` / `remove` against `/content/projectV2/...`                                 |
| Rename / insert / delete / reorder whole pages  | `edit_deck`                      | `retitle` / `insert` / `delete` / `reorder`                                       |
| Rewrite one page from scratch                   | `generate_scene` + `instruction` | **only** on explicit user intent for a full-page rewrite                         |

Rules of the matrix:

- One intent → one operation. Do not bundle changes you cannot individually name.
- **Address the leaf.** The smallest path that isolates your change is the correct
  one; writing a whole object back is how a neighbouring style field disappears.
- A `patch_stage` op **cannot change identity** — not the canvas id, not the element id set,
  not an element's `type`. Those go through `add_element` / `delete_element`, and a
  type change is a delete plus an add. Content itself is unchecked — it is stored
  exactly as written, so `slide-dsl` is the only thing standing between your markup
  and a broken page.
- **A rejected patch changed nothing.** A bad path, an out-of-bounds index, an
  unknown field, a wrong type or an invalid resulting page fails loud with the page
  as it was. Re-read and resubmit; never force.
- `add_element` takes one complete element JSON **without `id`** — the server
  validates the same structure contract as a patch, assigns
  the id, and inserts at `afterId` or `index` (one or the other).
- Nothing normalises your values. No colour, font or theme is rewritten toward a
  house style, so an edit that looks wrong is your value, not the tool's.
- `edit_deck insert` creates an empty stub; fill it with `generate_scene` using
  that new page's explicit `type` and `brief`, or patch an already valid scene.
- `generate_scene` with `instruction` discards the page and regenerates it. That is
  a rewrite, not an edit: reserve it for the moment the user plainly wants a page
  rebuilt, never as a shortcut around careful editing.
- If the session has attached materials or web access, use them to ground the
  content of your edits — never as an excuse to rebuild pages nobody asked about.

## Minimum-edit discipline

- Change exactly what was asked for. Do not restyle untouched elements, do not
  reword narration nobody complained about, do not "improve" adjacent pages
  while you are on one page.
- Keep the course's own voice: match its existing terminology, register and
  visual language. An edit should not be visible as an edit.
- Prefer fine per-field `patch_stage` ops over
  `generate_scene` whenever the
  target is narrower than a whole page.
- For any slide edit that touches geometry, colour, text length or rich-text
  structure, load `slide-craft`: it carries the design law the page was drawn
  under — the text height table, the type scale, contrast pairs, spacing
  rhythm, and which field on which element type actually reaches the screen.
- When you need the field itself — its name, its legal values, the path that
  addresses it, which of two fields the renderer reads — that is `slide-dsl`.

## Look → edit → look, on a budget

For layout-sensitive changes (positioning, density, new elements, alignment),
verify with `render_scene_preview` when it is available: look at the render,
edit, look once more. Budget **at most two preview rounds per page** — each
render costs a tool call and the whole run has a hard call cap. Do not preview
pages you did not touch, and do not loop past the budget: if two rounds have
not converged, stop and tell the user what remains instead of burning the rest
of the run on one page.

## Narration audio follows text

Setting a speech action's `/actions/N/text` with `patch_stage` clears the audio
of a reworded line, and inserted
lines have none. After any speech wording change, call `generate_tts` on that
page before moving on — its default mode synthesizes only the lines missing
audio, which is exactly what you need. Reworded text without regenerated audio
ships a silent page.

## Close with a consistency pass

Before telling the user the work is done:

1. `list_scenes` — confirm the page list matches what you intended: count,
   order, titles.
2. Each edit result already carried the fresh inventory of its page; verify
   against it, and re-read with `read_stage` only where a result left doubt.
3. Sweep the pages you touched for cross-page drift your edits could have
   introduced: the same concept named the same way, uniform units and
   terminology, a style you introduced applied everywhere it belongs.
4. Every speech action on a touched page must have an `audioId` (`read_stage`
   shows it); any page missing audio gets `generate_tts`.

## Share the course with human editors

Saves are last-write-wins per page, and a human authoring in the browser at
the same time can overwrite you as easily as you can overwrite them. Treat the
course as shared ground:

- **Read fresh, then write.** The `read_stage` call
  immediately before an edit is
  not a formality — it is how you avoid writing over a change the user made
  since you last looked.
- **Small, incremental writes.** Every tool call persists its change
  automatically as it lands; a sequence of small writes loses less to a
  conflict than one sweeping rewrite. Never accumulate a batch "prepared but
  not written" — write as you go.
- **Yield when the user is editing.** If the user says they are changing the
  same page, or a fresh read shows content you did not write, stop, re-read,
  and reconcile before writing again. Never overwrite a human's fresher
  version with your stale snapshot.

## Budget

There is no hard tool-call cap, but every extra call is latency the user
watches. Spend calls on edits, not ceremony: one `list_scenes` at entry, one `read_stage` per
page before its edits, the edits themselves, `generate_tts`
where wording changed, a preview round only where layout is genuinely at
risk. If the request is large, do the highest-value edits first and tell the
user what remains.
