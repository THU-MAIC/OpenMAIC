---
name: pptx-import
title: 'PPT 导入'
description: 会话里有上传的 .pptx，且用户要把这份幻灯片填进一节已建的课（先 create_stage 建课，再 import_pptx 把页面追加进这节课堂，保留原版排版；课堂标题以 create_stage 为准，PPT 不接管）。随后逐页检查（有 render_scene_preview 就渲染看）并修 bad case，理解整课之后才写旁白/spotlight，最后 TTS。仅在用户要求时插入 quiz 或 interactive。不要重新规划整课。
---

# PPT import as appended pages of a stage

Fill an uploaded PowerPoint's slides INTO the stage the user created with
`create_stage`: the slides become appended pages (or pages inserted at
`atOrder`), keeping the original layout. The stage keeps its own title and its
existing pages — the PPT is content, not the classroom's identity. Import,
**inspect and repair the pages**, **understand the course**, then write
classroom actions. Do not skip from import to TTS.

The learner-facing name is 「PPT 导入成课」. Never say "clone", "style
transfer", or "rewrite from the PPT".

Do **not** replan the imported deck. Do **not** call `generate_scene` on an
imported slide — that rebuilds the page and throws the original layout away.

## Order (do not rearrange)

1. `create_stage` for the classroom, then import the deck into it.
2. Roster.
3. Inspect every page (read, and render when the tool exists). Load
   `pro-editing` to fix visual bad cases. **Do not patch `/actions` yet.**
4. From that inspection, form a course reading (what it teaches, page roles,
   flow). Then write actions page by page.
5. `generate_tts`.
6. Quiz / interactive only if the user asked.

## Step 1 — create the stage, then import the deck

1. `create_stage` with the classroom's own title and brief. The stage — not the
   PPT — is the classroom: import never changes its title.
2. `list_materials`. Find the source `.pptx` (`mat_` id, mime or filename).
3. If several PowerPoints are attached, ask which one, unless the user already
   named it.
4. Call `import_pptx` with that source `mat_` id and the `stageId` from
   `create_stage`. Pages append after the existing ones, numbered
   consecutively. Pass `atOrder` to insert them at a position instead: pages at
   that order and beyond shift back. Existing pages are a normal premise — the
   PPT is one content source among others, never a reason to refuse.
5. A retry of the same material is idempotent — take the reused result and
   continue from Step 2; do not re-parse. If the user wants the same PPT again
   on purpose, delete its imported pages first (`edit_deck` `delete`), then
   retry.
6. Want pages beyond the deck (quiz, interactive, extra slides)? Insert a stub
   with `edit_deck` `insert`, then `generate_scene` that new page only with its
   explicit `type` and `brief` — do not
   re-import the deck to get more pages.

If there is no `.pptx`, say so and stop. Do not extract a PDF/DOCX and pretend
it was a slide import.

Speaker notes may already have become speech actions. Treat them as **drafts**.
Do not TTS them yet; they are rewritten in Step 4 after you understand the
course.

## Step 2 — roster

If the import result says no roster exists, settle the cast in conversation and
call `set_roster`. Voices are needed later for
TTS, not for the inspection pass.

## Step 3 — inspect pages, then fix bad cases

`list_scenes` is the map. Then **inspect before you edit**.

### 3a. Read

`read_stage` every imported page at `path:/scenes/<order|id>`. Record, in your own notes:

- title vs first real heading;
- element inventory (overflow candidates, empty boxes, missing `src`);
- garbled text;
- whether imported speaker-notes speech exists and whether it actually
  teaches this page.

A deck of more than 20 pages: still `list_scenes` fully; `read_stage` the
cover, every section-looking page, and every page whose title/excerpt looks
thin, garbled, or like a dump. Do not skip a page that looks empty.

### 3b. Render when the tool exists

If `render_scene_preview` is registered, **use it**. A `read_stage detail:"tree"` inventory
cannot see overlap, clipping, or a table running off the canvas.

- First pass: preview every imported page you read with `read_stage`. Look at the
  PNG, then decide whether that page needs a fix.
- After a visual fix: preview that page again (look → edit → look). At most
  **two extra previews per page**.
- If the tool is **not** registered, say so in one short sentence and inspect
  from `read_stage` only. Do not invent a screenshot.

Do not call `render_scene_preview` on pages you have not read, and do not
preview quiz/interactive stubs you have not inserted yet.

### 3c. Fix only bad cases

**Load `pro-editing` first.** `read` its SKILL.md (the path is in
`<available_skills>`), then follow that skill's surgical loop for every
visual repair: `read_stage`, the smallest `patch_stage` / `edit_deck` op,
`render_scene_preview` look → edit → look. Stay in `pro-editing` until the
bad cases below are done. Do not skip the load and invent a parallel edit
style.

| Problem                                       | Tool                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Empty or garbage title                        | `edit_deck` `retitle` from the first real heading                                                                                |
| Overlap or overflow                           | `patch_stage` `set` on that element's `/content/canvas/.../left` / `top` / `width` / `height`, one number per op                  |
| Leftover empty boxes                          | `patch_stage` `delete_element`                                                                                                    |
| Broken or missing image                       | `patch_stage` `set` on `/content/canvas/elements/N/src`, only if you have a real replacement URL; otherwise leave it and mention it |
| Garbled text, leftover font-substitution junk | `read_stage detail:"source"`, then `patch_stage` `set` on that element's rich-text path                                           |

Rules:

- Keep the original visual language. Do not restyle the deck to "look more
  like OpenMAIC".
- Change only what is broken or unreadable.
- **Do not write or rewrite actions in this step.** Layout first.
- When the layout pass is done, return here for Step 4. Do not continue
  `pro-editing` into narration.

## Step 4 — understand the course, then write actions

Only after Step 3. You now have a page list, inventories, and (if available)
previews. Form a short course reading before touching actions:

- What is the course arguing or teaching, in order?
- Which pages are cover / section / content / recap?
- What should the teacher **say** on each page (not what the slide already
  prints)?
- Which element should be spotlighted while that line is spoken?

Then write playback actions with `generate_actions` **page by page, in order**
(it drafts the full action set from the page content and course context, and
synthesizes audio by default — reserve `patch_stage` on `/actions/...` + `generate_tts` for
line-level fixes afterwards):

- `insert_speech` / `set_speech`: one or a few teacher lines that teach this
  page. Do not read the slide aloud verbatim. Speaker notes are a draft to
  rewrite, not a script to keep if they are outline-speak or leftover PPT
  comments.
- `set_spotlight`: bind the line to the element it is about (`elementId`
  from `read_stage detail:"source"`). Skip spotlight when the page is a title-only cover.
- `delete` imported speech that does not teach.

Do **not** call `generate_scene` to "generate actions". That regenerates the
slide.

## Step 5 — TTS

After a page's actions are settled, `generate_tts` that page (default mode
fills missing `audioId` only). Reworded speech has no audio until this runs.

Before saying the import is ready to teach: every page that has speech must
have `audioId`. `read_stage detail:"source"` shows it.

## Step 6 — add quiz / interactive only on request

If the user did **not** ask for quiz, interactive, or extra pages, stop after
Step 5. One sentence is enough: they can ask to insert a quiz or an
interactive page next.

If they did ask:

1. Say which pages you will insert, where, and why — then do it.
2. `edit_deck` `insert` with `type=quiz` or `type=interactive` at the chosen
   `atOrder`. This creates an empty stub; it does not copy a PPT slide.
3. `generate_scene` **only that new page**, with the explicit page `type` and
   `brief` plus
   `materialFacts` taken from the surrounding imported slides. Never
   regenerate an imported slide in this step.
4. A new interactive page must have a real `widgetType` and a filled
   `widgetOutline`. A quiz must have real questions, answers, and analysis.
5. `generate_tts` the new page if it has narration.

Do not sprinkle quizzes through the deck "for engagement" when nobody asked.

## Closing

1. `list_scenes` — imported slides still in order, plus any pages you inserted.
2. Touched speech has `audioId`.
3. Tell the user in one or two sentences what was imported, what you fixed
   visually, and that narration is in. Do not dump a page-by-page changelog.

## Hard rules

- `import_pptx` is the source of visual truth. Replanning the imported deck is
  the wrong workflow for this skill.
- Inspect and repair **before** writing actions. Actions **after** you
  understand the course.
- `generate_scene` is allowed only for **newly inserted** quiz/interactive
  stubs, or when the user explicitly asked to rebuild one imported page.
- Do not extract the PPT with `extract_material` and teach from the text.
- Do not invent images, citations, or slide content that was not in the file.
- If import fails, report the tool error. Do not fall back to an AI rewrite
  unless the user then asks for that different path.
