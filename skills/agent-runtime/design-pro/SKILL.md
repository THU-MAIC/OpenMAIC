---
name: design-pro
title: "视觉精修"
description: >-
  Professional visual design for the whole course — a committed aesthetic,
  characterful typography, a disciplined palette, and error-free self-contained
  interactive pages. Layer it on top of any course shape when the requirement
  asks for refined, polished, beautiful, distinctive, or better-designed output,
  when a previous generation looked generic or template-like, or when pages
  shipped with broken layouts, wrong-language UI labels, or console errors. It
  works ONLY through your tool calls: compose one Design Card and carry it into
  every generate_scene brief — guidance you read but never send changes nothing.
---

# Design-pro: the course looks designed, not generated

**The one mechanic that matters: the page generators never see this skill, the
conversation, or your intentions — they see the `brief` (and `instruction`)
you pass to `generate_scene`, and nothing else.** Taste you do not write into
the call does not exist. Everything below funnels into that.

## Step 1 — compose the Course Design Card (once, before any page)

Pick ONE aesthetic direction for the whole course and commit: brutally
minimal, editorial/magazine, industrial/utilitarian, retro-futuristic,
luxury/refined, playful/toy-like, organic/natural, art-deco geometric.
Subject suggests direction (safety-critical vocational → industrial clarity;
a history seminar → editorial), but any executed direction beats none.

Then write a compact DESIGN CARD naming concrete values, for example:

```
DESIGN CARD (apply to every visual decision on this page):
Direction: industrial clarity. Palette: background #F4F2ED (paper),
ink #1A1D21, ONE accent #C8451B used only for warnings/emphasis —
no other hues, no pastel category colors, max 2 neutrals between them.
Type: display = a characterful slab or grotesque (never Arial/Inter/
Times-default), body = one refined sans; two families total.
Layout: one dominant focal element per page, strong left-aligned column,
whitespace over boxes. FORBIDDEN: pastel rainbow stat-tiles, one box per
color, decorative gradients, emoji as icons, four-equal-boxes grids,
filler sections.
Language: entire page in English, INCLUDING every UI label inside
interactive HTML — buttons, step/progress text, feedback strings.
```

Vary the values per course (palette hexes, fonts, direction) — never reuse
this example verbatim; sameness across courses is its own slop.

## Step 2 — carry the Card in EVERY generate_scene call

- Append the full DESIGN CARD to the `brief` of every `generate_scene`,
  after the content brief. Every call, every page type — slide, quiz,
  interactive, pbl. A page generated without the Card will not match the
  others.
- When revising an existing page, put the specific design fix in
  `instruction` (it becomes the generator's edit directive):
  "Recolor to the Design Card palette; collapse the four stat tiles into one
  dominant number plus a compact secondary row; English button labels."
- Where a tool accepts `styleDirective` (narration/actions generation), pass
  the Card's direction line so the spoken register matches the visuals.

## Step 3 — verify before moving on

After generating a page, `read_stage` it and check against the Card:

- Colors outside the palette? Pastel category-tinted boxes? → regenerate with
  a sharper FORBIDDEN line in the brief.
- Any non-English UI string in interactive HTML (按钮/上一步/下一步 etc.)? →
  revise with `instruction`; the language line was ignored, restate it first.
- Interactive pages must be self-contained (inline CSS/JS, no CDN links,
  system-font stacks or embedded fonts), render complete with JS failed,
  survive every state without console errors (guard selectors, parses,
  indexes), keep body text ≥16px, contrast ≥4.5:1, hit targets ≥44px.
- One well-orchestrated reveal beats scattered hover effects; everything
  still works with animations off.

## Boundaries

- `slide-craft` owns the slide canvas numbers (geometry, height table, type
  scale) — the Card styles WITHIN those numbers, never against them.
- Small edits touch only what was asked — never restyle neighbouring
  elements uninvited; offer the broader pass instead.
- Operator-supplied brand colors or reference material always beat the
  chosen direction.
- No hand-drawn SVG illustrations of real things (people, devices, scenes) —
  typography, geometry, and generated images instead.
