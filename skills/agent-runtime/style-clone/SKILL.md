---
name: style-clone
title: "名师复刻"
description: Building a new course inside someone else's deck — import the deck as a library of layouts, then produce each page of the new course by copying the layout that fits it and rewriting that copy's content element by element, so the result reads as though the original author made it. Use when the session has an imported deck (or a `.pptx` to import) and the ask is to teach new material in its design — its palette, its typography, its way of dividing a page. Not for a straight import that must stay slide-for-slide identical to the file (that is `pptx-import`), and not for extracting how a teacher speaks from a recording or handout (that is `teacher-style-clone`, which supplies the voice while this one supplies the look; the two compose).
---

# Cloning a deck's style

The user has a deck by someone whose slides are worth copying. Your job is to
produce **new pages that look like that deck made them** — its palette, its
typography, its background treatment, its way of dividing a page — while the
teaching content on those pages is entirely new. New content in the old style is
the whole point of this mode, not the exception.

The route is **copy, then refine**. For every page in the new course you pick the
source layout that fits it, `duplicate_scene` that layout, and rewrite the copy's
content element by element. The design is preserved because you copied it, not
because you described it.

Generation is not an alternative for a **copied page**. `generate_scene` re-rolls a page from its
outline entry and draws in the house look, and no free-text slot on it overrides
that: a real run that wrote the source deck's exact hex values and font names
into `materialFacts` on every page produced pages where those values appear
**zero** times. Describing a style to a generator does not transfer it. Copying
the element tree does.

The learner-facing name for this mode is 「名师复刻」. Never show the learner the
machinery — no talk of templates, clones or source pages. They should just see a
course that looks like it came from one hand.

## Why this works now

Copy-then-refine failed the first time it was tried, and the reason was the
editing tools, not the approach. The only content editor then was a whole-block
text setter, and 35 of one run's 44 edits went through it: each one replaced a
block wholesale and flattened everything inside it, so a title's size and colour
left with its words, contrast pairs came apart, and tables that resisted editing
were shipped still carrying the old subject's text.

Those lossy ops are gone from the agent surface. What replaced them is an
element-level, full-fidelity seam of three parts:

- **`read_stage` with `path:/scenes/<order|id>` and `detail:"source"`** returns the page's exact persisted JSON —
  `background`, each text element's `defaultColor` and `defaultFontName`, the
  inline `color` / `font-size` / `font-family` inside its `content` HTML, shape
  fills, and exact geometry. It is your fidelity source *and* your address space:
  the paths you read are the paths you write.
- **`patch_stage`** writes **one scene-root JSON Pointer path** with `op:"set"`
  or `op:"remove"`. `/content/canvas/elements/0/content` replaces one text
  element's rich-text HTML and touches nothing else on the page; a `<span>` keeps
  its colour and size while its words change. Address the leaf, and everything you
  did not name keeps the value you copied.
- **`add_element`** (a complete, id-less element JSON, id assigned by the server)
  and **`delete_element`** are the only ways the element set changes — a patch may
  not add, remove, rename or retype an element, which is exactly the guard that
  keeps a borrowed design intact.

So **one atomic patch is the entry point for every content rewrite**, whatever the
element is — a paragraph at `/content/canvas/elements/3/content`, a shape's label at
`/content/canvas/elements/3/text/content`, a table cell at
`/content/canvas/elements/5/data/0/0/text`, a code line at
`/content/canvas/elements/9/lines/1/content`, a formula's `latex`, a chart's label. There
is no per-type editor to hunt for and no growing list of per-type operations: read
the source JSON, find the path that holds the words, write that path.
**`slide-dsl` is the field manual** — which field holds the words in each of the
ten element types, the pointer rules, what values are legal, which field the
renderer reads when two disagree, and what the renderer really does with the HTML
you write.

Two guarantees are what make this trustworthy on someone else's design: **a
rejected patch changes nothing** (a bad path, an unknown field or unsafe HTML fails
loud with the page exactly as it was), and **nothing is normalised** — no colour,
font or theme value is rewritten toward a house palette. The deck's look survives
because the tool has no opinion about it.

`stage-design` governs the build of the stage this produces, and
`curriculum-planner` governs a series of them; both still apply, and this skill
shapes only how the pages get their look. `page-clone` carries the per-page
mechanics of the loop in Step 4 — read it before the first page. `slide-dsl` is
the field-level truth about the JSON you are patching, `slide-craft` is the
design law any page still has to satisfy, and `pro-editing` is loaded mid-run
when a refined page comes out broken.

## What finishing a turn means here

Getting the deck in and reading it are **preparation, and preparation is not a
result**. A real run read the skills, imported a 36-page reference deck, and ended
its turn on 「已确认当前课堂已保存 36 页原始课件……我不会覆盖这些页面」 — the layout
library ready, the user's own course **not one page written**. The user asked for a
lesson and got an inventory of someone else's.

A turn ends in exactly one of three states:

- **the new course moved a real step** — at least the next planned page copied
  with `duplicate_scene` and refined, persisted, not merely chosen;
- **`ask_user` is waiting** on a decision only the user can make;
- **every planned page is in the deck** and the checks in Steps 5–7 have passed.

A statement about what you have imported, catalogued, confirmed or intend to do
next is none of those, however true it is. Once the deck is in, run straight
through — catalogue, plan, then page after page through Step 4's loop — and do not
hand the turn back between them.

## Step 1 — get the deck in

Call `list_scenes` first. If the source deck's pages are already persisted in this
stage, it is imported — **skip to Step 2**. Otherwise the user's `.pptx` goes
through `import_pptx`, which lands its pages as real scenes you can read and copy.
A returned import is not news worth a turn: continue into Step 2 in the same turn
that imported it.

The imported pages are **material, not deliverables**. They are the layout
library this whole skill runs on, and every page you ship is a *copy* of one of
them made with `duplicate_scene`. Never rewrite a source page in place: editing
the library destroys the template for every later page that needed it, and a run
that did exactly that left the original course mangled with nothing to fall back
to. Decide at the end, with the user, whether the source pages stay in the deck
or get removed with `edit_deck delete` — not before you have copied everything
you need out of them.

If the user actually wants the file itself served slide-for-slide with no new
content, that is `pptx-import`, not this skill.

## Step 2 — catalogue the deck as a layout library

Read the source deck for its **layout roles**, not its subject: the small set of
page forms the author reuses. A deck rarely has more than six.

- `list_scenes` for the inventory, then read a sample spread across the deck —
  the cover, a section divider, a plain content page, a two-column or
  image-plus-text page, a data or table page, the closing page. Sample by
  variety, not by position; the first five pages of a deck are usually the same
  two forms.
- Read each sample with **`read_stage detail:"source"`**. The default tree view
  strips exactly the fields a layout is made of — background, colours, fonts,
  inline marks — so a catalogue built from it is a catalogue of text.
- For every role write down, in your own reasoning, **its template scene id** and
  **its capacity**:
  - how many text slots it has, and roughly how long the text in each one is;
  - whether it has an image slot, a table, a code block, a formula, a chart;
  - which elements are the skeleton (see Step 4).

  Capacity is the number that decides everything later — the commonest way a
  copied page fails is content the layout was never sized for.
- Note the shared visual language across roles too — the palette, the heading
  treatment, how emphasis is marked — because a page you generate rather than copy
  (a quiz, an interactive page: forms a `.pptx` has no layout for) still has to
  sit next to the copied ones without a visible seam.

## Step 3 — plan the new course, normally

Plan the course the user actually asked for in conversation, with an explicit
title, type, and brief for every page. The plan is about content; the deck is about form, and the two are decided separately — do not
let the source deck's page order become the new course's structure unless the user
asked for a like-for-like rebuild.

Call `create_stage` for that planned course, then settle the cast and call `set_roster` — the classroom is still a classroom.

## Step 4 — copy and refine, one page at a time

This is the core loop. For each outline entry, in ascending page order:

1. **Branch on whether the source deck has a cloneable layout for this page
   type.** For a quiz, interactive page, or any other type whose form does not
   exist in the `.pptx` library, call `generate_scene` directly for this page
   with its explicit `order`, `title`, `type`, and `brief`. Do not insert an
   empty page with `edit_deck` and hand-author its content. Check that the
   generated page follows the source palette and typography noted in Step 2,
   then continue with the next outline entry. Only the copied-page branch below
   forbids `generate_scene`.
2. **Pick the template** by role *and* capacity. A content page gets a content
   layout; a page that turns a corner gets the section divider; the opening page
   gets the cover. Five key points do not go into a layout built for two lines —
   pick a roomier role or split the page. Rotate between templates of the same
   role: eleven identical pages look cloned in the bad sense.
3. **`duplicate_scene({ templateSceneId, targetOrder, title })`** — an exact copy
   of the template at the position you want. Pass a `title` that names the NEW
   page; the copy inherits the template's outline brief, and a page still called
   「第 3 章回顾」 misleads the learner and the narration step alike.
4. **`read_stage` the copy with `detail:"source"`.** Work from the copy's own
   element ids, never the template's.
5. **Sort every element into content slot or skeleton.** Content slots are the
   ones whose words belong to the old subject. Skeleton is everything else —
   divider rules, colour bands, page numbers, logos, decorative shapes, section
   numerals, background art — and **skeleton is not touched**, even when it holds
   text. It is the part that makes the page recognisably the author's.
6. **Rewrite each content slot with one `patch_stage` `set` op per slot** on the
   exact path that holds its words and nothing else. `slide-dsl` says which path
   that is for each element type — `content`, `text/content`, a cell's `text`, a
   line's `content`, `latex`. Preserve the inline structure while you change the
   words: a slot whose source had a coloured `<span>` keeps a coloured `<span>`;
   one that had three `<p>` paragraphs stays three paragraphs. Source HTML in,
   source HTML out.
7. **Put a real picture where the layout wants one.** Call
   `generate_image({ prompt, aspectRatio?, styleHint? })` for the visual, then
   `patch_stage` `set` its returned `src` onto the layout's existing image element
   (`/content/canvas/elements/N/src`), or `add_element` a full-fidelity image element where
   the layout has none. Match `aspectRatio` to
   the box, and put the deck's palette and art direction into `styleHint` — a deck
   built on flat diagrams must not suddenly grow a glossy stock photo. Never leave
   an empty frame, and never invent a `src`: if `generate_image` is not registered
   in this session, say so in one sentence and leave the layout without an image
   rather than with a broken one.
8. **Resolve a capacity mismatch in this order**, which is `page-clone`'s rule
   applied page after page: cut the wording to what the layout holds →
   `delete_element` the slots you cannot meaningfully fill → move to a roomier
   template from the library (and `edit_deck delete` the abandoned copy) → and only
   as a last resort `add_element` a copy of a neighbouring slot, with its box
   already set into their rhythm. From the third of those on, you are drawing
   rather than copying, and it shows if you are careless.

Then the next page. Each page's copy and its edits are that page's durable
checkpoint, exactly as `stage-design` requires. One `read_stage detail:"source"`
at the start of a page is enough — every `patch_stage` result carries the page's
fresh inventory back.

## Step 5 — leave nothing of the old subject standing

This is the failure that shipped last time, so it gets its own pass. Before a page
is done, read it back with **`read_stage detail:"text"`** — every text-bearing
element as `{ path, id, type, text }` plus one page-wide `combinedText` — and check
it for the source course's words. One call gives you the whole page, which is what
makes this cheap, and each entry carries the pointer you would fix it at. Reading
all of it is the point, not re-reading the slots you remember editing.

The places residue actually hides:

- **table cells** — a table is one element, and a patch that rewrote the header
  row leaves the body rows saying whatever the source said;
- **shape labels** — text inside a shape reads as decoration, so it gets
  classified as skeleton and skipped;
- **code blocks and formulas** — plausible-looking content nobody re-reads;
- **small type** — footers, captions, source lines, section numerals naming the
  old chapter, an author's name in 10px grey.

Every element ends up deliberately replaced, deliberately kept, or deleted. A slot
you neither replaced nor deleted is a bug — the old subject leaking into the new
course — and anything carried over is a **claim in the new course**: if it is
stale, or belongs to the old subject, it goes. `set`, `remove`, or `delete_element`
whatever the sweep turns up, at the `path` it handed you.

This pass covers what the page *shows*. What it *says* is swept the same way once
narration exists, in Step 7 — and that half is the one that has shipped residue.

## Step 6 — verify the ones likely to be broken

Copied text is almost never the length the layout was designed around. Spend
`render_scene_preview` calls where they buy something: the **first page copied
from a given template**, and any later page whose text is visibly longer than what
it replaced. Skip the rest — previews cost calls, and the second page in a proven
template rarely surprises you.

When a page overflows or breaks, load `pro-editing` and converge inside its budget
of **two preview rounds**. Shorten the words first: a borrowed layout is a
statement about how much can be said on one page, and cutting text preserves the
design where moving boxes destroys it. Patch a box only when the text is already
tight. If two rounds have not converged, move that content to a roomier
template or name the page to the user. Do not ship a page with text running off it.

## Step 7 — give every page a voice

A duplicated page arrives silent. Call `generate_actions` for each one; it
connects TTS by default, so audio lands with the narration rather than needing a
separate pass.

Pass a `styleDirective` that keeps the teaching persona consistent with the source
course's register — how formal it is, how it addresses the learner, how much it
explains versus asserts. A deck whose look is faithfully reproduced but narrated
in a completely different voice does not read as the same author's work.

If the session also has a recording or handout by the same teacher, run
`teacher-style-clone` for the delivery profile and feed its findings into the
`styleDirective`. The two skills compose: that one supplies the voice, this one
supplies the look.

Then read every page back with `read_stage detail:"source"` and check **what the narration says**,
not only that each speech action has an `audioId`. Narration is written from the
page's content plus its outline brief, and that brief was inherited from the
template — so residue arrives through it even when the visible text is clean. A
real run's new page on model self-evolution came back narrated
「今天的课程就全部结束了……深度学习的基础知识……」: the reference deck's own closing line,
on a page that was neither a closing page nor about deep learning, with nothing
wrong on the slide itself.

The narration has to be about **the new course**. The source course's name, its
subject vocabulary, and its stage-of-course phrasing are residue wherever they
turn up — and a wrap-up line 「今天的课程就全部结束了」 on a page that is not the last
page is residue even when the subject is right. Fix what you find with
`patch_stage` on the exact `/actions/N/text` pointer, then `generate_tts` that page: reworded narration is
a silent page until it is re-synthesized.

## Hard rules

- **New content in the old style is the goal.** Teaching material the source never
  covered, drawn in the source's look, is exactly what this mode is for.
- **Copy the design; never regenerate a copied page.** `duplicate_scene`, then one
  `patch_stage` `set` op per content slot. `generate_scene` on a page you copied throws away the design
  you came for, and style directives passed to it do not survive into the page.
- **Source pages are the library.** Copy out of them; do not edit them in place.
- **Read with `detail:"source"` before you patch.** The default inventory strips
  the colours, fonts and inline marks that are the entire point of the clone.
- **Content changes; design does not.** No style path, no geometry path, no
  restacking while refining a copy, unless the layout genuinely has to grow and you
  have read its neighbouring boxes first.
- **Skeleton is untouchable.** Rules, bands, numerals, logos and decorative shapes
  are what make the page the author's; they survive every refinement.
- **No source text survives by accident.** Sweep every page with
  `read_stage detail:"text"` before it ships — table cells, shape labels, code and
  small type included.
- **The narration is swept too.** Read the speech text back after
  `generate_actions`; the source course's subject, name or wrap-up wording in a
  narration line is the same bug as its words on the slide; `patch_stage` plus
  `generate_tts` is the fix.
- **Preparation is not a stopping point.** A turn ends on a page that landed, on
  `ask_user`, or on a finished deck — never on a report that the deck is imported
  and the layouts are understood.
- **Images match the deck.** A generated image whose palette or medium fights the
  page it sits on is worse than no image.
- **Style is what you clone, not identity.** No fabricated biography, opinions,
  endorsements or claims attributed to the original author.
