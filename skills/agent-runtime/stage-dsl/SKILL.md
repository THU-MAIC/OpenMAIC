---
name: stage-dsl
title: "课堂文档结构"
description: The map for reading and editing an OpenMAIC stage document with read_stage, patch_stage, and grep_stage. Load it before patching a structure you have not patched before, when patch_stage rejects an operation, or whenever the path from a stage, outline, scene, content object, or action to the field you need is uncertain. It routes to field-level references for quizzes, interactive widgets, actions, and PBL projects; the installed slide-dsl skill remains the complete slide canvas manual.
---

# The stage document map

This is a map, not the field manual.

Use it to decide which subtree owns a value, which path to read, and which
reference chapter to load. Then read the exact source before writing.

## The document model

The durable structure is:

```text
stage
├── outline
└── scenes[]                    ordered by scene.order, shown as pages 1..N
    ├── id                     stable scene identity
    ├── order                  1-based page position
    ├── type                   slide | quiz | interactive | pbl
    ├── content                shape selected by scene.type
    │   ├── slide.canvas
    │   ├── quiz.questions[]
    │   ├── interactive.html / widgetConfig
    │   └── pbl.projectV2
    └── actions[]              ordered playback verbs
```

`stage` is the stage's metadata. `outline` is the generation plan. A persisted page
is a scene. Its `type` and `content.type` must agree.

The three generic tools do not replace page-list operations. Insert, delete,
reorder, and retitle pages with `edit_deck`.

## Tool vocabulary

| Need | Tool | How |
| --- | --- | --- |
| Read a scene | `read_stage` | `path:/scenes/<order|sceneId>` with the required detail |
| Edit scene content or actions | `patch_stage` | `target:/scenes/<order|sceneId>` and scene-root JSON Pointer ops |
| Search visible text or source | `grep_stage` | literal search over the whole stage |
| List stages in folders | `list_folder_stages` | returns the explicit `stageId` required by every stage tool |
| Insert, delete, reorder, or retitle pages | `edit_deck` | page-list operations stay outside the document patcher |
| Plan and build a new stage | conversation + `create_stage` + `generate_scene` | settle the page plan in conversation, then call `generate_scene` once per page with an explicit brief |
| Set the classroom cast | `set_roster` | write the settled roster before page generation |

## Addressing with read_stage

| Path | Resolves to |
| --- | --- |
| `""` or omitted | the whole stage |
| `/outline` | the persisted outline snapshot |
| `/scenes/3` | the scene whose `order` is 3 |
| `/scenes/scene_abc` | the scene with that stable id |
| `/scenes/scene-abc` | the historical hyphenated scene-id form |
| `/scenes/3/actions` | only scene 3's action array |

Orders are 1-based. Array indices inside source JSON are 0-based.

`detail:"tree"` is the compact structural inventory. It reports scene id,
order, type, title, element/question/project counts, and action counts. It is
for finding a target, never for reconstructing a write value.

`detail:"source"` is the exact JSON at the selected path. A scene source is the
persisted scene object, so writable pointers begin `/content/...` or
`/actions/...`. Inline media bytes larger than 2 KiB are replaced in this read
projection by a read-only placeholder. The stored document is unchanged.

`detail:"text"` is the visible-text projection. Use it to find learner-facing
copy or prove that old wording no longer remains. It deliberately omits known
internal PBL prompts and runtime state.

Source and text responses are character-paged after 12,000 characters. Pass
the returned `nextOffset` back as `offset` until it disappears.

## Writing with patch_stage

`target` is one scene path: `/scenes/<order|sceneId>`.

Every call carries a human `intent` and one or more `ops`. The ops are atomic:
the server applies them to a clone, validates the resulting scene, and writes
once. If op 2 fails, op 1 is not persisted.

| Op | Fields | Meaning |
| --- | --- | --- |
| `set` | `path`, `value` | replace an existing leaf or add an optional object key |
| `remove` | `path` | delete an existing object key or splice an array index |
| `str_replace` | `path`, `oldText`, `newText`, optional `replaceAll` | replace one exact occurrence of `oldText` inside the string field at `path`; `replaceAll:true` replaces every occurrence |
| `add_element` | `element`, optional `afterId` or `index` | add one complete id-less slide element |
| `delete_element` | `elementId` | delete one slide element by stable id |

Set/remove/str_replace paths are JSON Pointers rooted at the scene source:

```text
/content/canvas/elements/0/content
/content/questions/1/options/0/label
/content/widgetConfig/description
/content/projectV2/milestones/0/title
/actions/2/text
```

Escape `/` in an object key as `~1` and `~` as `~0`. Array indices are
canonical zero-based integers: `0`, `1`, `2`, never `03`, `-1`, or `+1`.

Every intermediate segment must exist. `set` may create only the final object
key. `remove` requires the final key or array slot to exist.

For a change inside a large HTML document or long text field, prefer
`str_replace` over rewriting the whole field with `set`: transcribing 27 KB of
HTML to change one number is expensive, and any transcription error silently
corrupts the page. Read `detail:"source"`, pick a short unique anchor, replace
it, then read back and `grep_stage` to verify. `oldText` must appear exactly
once in the stored string; on multiple matches extend the anchor or set
`replaceAll:true`. Neither `oldText` nor `newText` may contain a read-side
media omission placeholder; `newText` may be empty to delete the anchor.

Scene metadata is not writable here. Paths must begin `/content/` or
`/actions/`; use `edit_deck` for page metadata and page-list changes.

## Finding with grep_stage

`scope:"text"` searches the visible-text projection. `scope:"source"`
searches serialized scene JSON, including field names and internal data.

Search is literal, case-insensitive, and applies NFKC to both query and source.
Thus half-width `AI` finds full-width `ＡＩ`. Result `start` and `end` still slice
the original, unnormalized scene string correctly.

A call returns at most 10 matches per scene and 30 overall, within its time and
character budget. `truncated:true` always includes an opaque `cursor`. Repeat
the same query, scope, and stage with that cursor to continue.

## Read before write

For every edit:

1. Read the target scene with `detail:"source"`.
2. Locate the exact field and array index in that source.
3. Load the matching field-reference chapter below if this structure is new to
   you or a previous patch was rejected.
4. Patch the smallest leaf that expresses the intent.
5. Read the same source path again and verify the stored value.
6. Use `detail:"text"` or `grep_stage` when the check is “no old copy remains.”

Never build a patch from `tree`; it intentionally omits neighbouring fields.

Never copy a `<… bytes omitted: …>` media placeholder into a write. Supply a
new real URL/src or leave that field untouched.

## Route to the field manual

| What you need to write | Read this first |
| --- | --- |
| Slide canvas, background, theme, any of the ten slide element types | Read the installed `slide-dsl` skill at the location shown in `<available_skills>`. It is the complete manual and its examples already use scene-root `/content/canvas/...` pointers. |
| Quiz questions, options, answers, grading fields | [`references/quiz.md`](references/quiz.md) |
| Interactive HTML or typed widget configuration | [`references/widget.md`](references/widget.md) |
| Narration, spotlight, whiteboard, video, discussion, or widget playback actions | [`references/actions.md`](references/actions.md) |
| PBL projectV2 roles, milestones, microtasks, packaged design, or runtime-owned fields | [`references/pbl.md`](references/pbl.md) |

## Validation boundary

Slides use the closed slide element schema and reject unknown fields, wrong
types, missing required fields, id changes, and element-type changes.

Quiz writes add a closed question/option check around the current document
validator. Interactive content is closed at its content root, but historical
widgetConfig objects remain intentionally tolerant below that root. PBL is
closed at its content root, while the existing projectV2 validator requires its
core containers and deliberately tolerates historical runtime extension fields.

That difference matters: “accepted” means the current persisted contract
accepted the shape, not that every value is pedagogically sound or every
renderer consumes it. The reference chapters name the hard boundary and the
known semantic boundary separately.

## Hard rules

- Read source before every patch and read it again afterward.
- Patch one leaf when one leaf is enough.
- Use scene-root paths: `/content/...` and `/actions/...`.
- For a change inside a large HTML or long text field, use `str_replace` with a short unique anchor instead of rewriting the whole field.
- Use `add_element` and `delete_element` for slide element identity changes.
- Do not use patch_stage for page insertion, deletion, reordering, or titles.
- Do not write media omission placeholders.
- A rejected atomic batch changed nothing.
- When uncertain, stop guessing and read the matching reference chapter.
