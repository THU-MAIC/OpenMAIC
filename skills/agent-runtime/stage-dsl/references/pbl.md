# PBL projectV2 field reference

This chapter describes the current PBL payload at
`scene.content.projectV2`.

It is derived from the app's PBL v2 types, `applyPblEdit`, the shared DSL PBL
contract, and `validateAppScene`.

Authoring paths: `generate_scene` with `type:"pbl"` mints a complete
`projectV2` from the page brief (v2 single-call planner) — this is the normal
way a PBL page is created; `patch_stage` then fine-tunes the project's
authoring fields, and `edit_deck` inserts a blank pbl stub when the page must
be created empty first.

PBL has the widest gap between authoring types and the persisted write
barrier. Read the validation section before patching.

## Content root

```json
{
  "type": "pbl",
  "projectV2": { "...": "..." }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | string | yes | exactly `pbl`; must match `scene.type` |
| `projectV2` | object | no for legacy compatibility | current PBL project |
| `projectConfig` | object | no | read-only legacy v1 data |

`patch_stage` closes this content root. Unknown siblings of `projectV2` and
`projectConfig` are rejected.

Do not author new `projectConfig` data. It is retained for old scenes and the
current runtime uses `projectV2`.

## Validation boundary

For a new v2-only scene, `validateAppScene` requires `projectV2` to contain
array containers for:

```text
milestones | roles | threads
```

The shared PBL guard additionally recognizes the packaged project skeleton,
but deliberately tolerates unknown project-tree members because historical
documents carry app runtime fields.

When a scene contains a sound, non-empty legacy `projectConfig`, the app write
barrier preserves a damaged `projectV2` as inert historical bytes rather than
blocking every aggregate save.

Therefore PBL validation is not a closed field-by-field schema. The TypeScript
interfaces below are the authoring reference, but an incomplete or misspelled
nested field may be accepted. Always read back and, for risky changes, exercise
the PBL surface.

## Project root

Core fields in `PBLProjectV2`:

| Field | Type | Required | Legal values / meaning |
| --- | --- | --- | --- |
| `uiPhase` | string union | yes | `hero` / `generating` / `workspace` / `completed` |
| `title` | string | yes | project title |
| `description` | string | yes | what the learner will build/do |
| `learningObjective` | string | no | what the learner should learn |
| `gains` | `string[]` | no | learner-facing takeaways |
| `proficiency` | string union | yes | `""` / `beginner` / `intermediate` / `advanced` |
| `language` | string | yes | locale fallback |
| `languageDirective` | string | no | authoritative nuanced content-language policy |
| `tags` | `string[]` | yes | free-form tags |
| `schemaVersion` | number | no | reserved packaged-format version |
| `status` | string union | yes | `designing` / `review` / `active` / `completed` / `archived` |
| `roles` | `PBLRole[]` | yes | agent participant records |
| `milestones` | `PBLMilestone[]` | yes | ordered stages |
| `submissions` | `PBLSubmission[]` | yes | learner deliverables/runtime data |
| `evaluations` | `PBLEvaluation[]` | yes | feedback/runtime data |
| `threads` | `PBLAgentThread[]` | yes | agent chat/runtime data |
| `engagementEvents` | `PBLEngagementEvent[]` | yes | runtime analytics ledger |
| `createdAt` | string | yes | ISO timestamp by contract documentation |
| `updatedAt` | string | yes | ISO timestamp by contract documentation |

Optional runtime/adaptive fields include:

- `proficiencyAssessment`
- `runtimeEvents`
- `runtimeResetEpoch`
- `pendingHandover`
- `pendingTaskCompletion`
- `pendingOpenTaskPriorQuizResults`

Those fields belong to learner runtime state, not ordinary course authoring.
Do not reset, synthesize, or “clean up” them through content editing.

Unlike the old `applyPblEdit` menu, generic pointer writes do not automatically
refresh `projectV2.updatedAt`. If the product requires that timestamp for an
authoring change, include an explicit second op with a real ISO timestamp. Do
not rewrite it merely for cosmetic diff consistency without a consumer need.

## Roles

A `PBLRole` is:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | role identity |
| `type` | role union | yes | see below |
| `name` | string | yes | displayed name |
| `description` | string | no | short learner-facing avatar tooltip |
| `systemPrompt` | string | no | internal persona/behavior prompt; not learner-facing |

Role type union:

```text
user | instructor | evaluator | mentor | collaborator | simulator | system
```

The current product creates one Instructor role. `simulator` and `system` are
scenario message role types, not ordinary `roles[]` records according to the
type documentation.

`description` must not expose internal mechanics. `systemPrompt` is internal
and is excluded from the visible-text projection.

Threads reference roles through `agentId`. Changing a role id requires updating
every matching thread and any other reference atomically. Prefer preserving ids.

## Milestones

A milestone requires:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | identity |
| `title` | string | displayed stage title |
| `status` | `locked` / `active` / `completed` | lifecycle state |
| `order` | number | 1-based authored ordering convention |
| `microtasks` | `PBLMicrotask[]` | ordered steps |

Optional authoring fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `description` | string | stage description |
| `documents` | `PBLDocument[]` | legacy/future resource slot |
| `briefing` | string | Instructor setup script |
| `completionCriteria` | string | stage completion rule |
| `debrief` | string | wrap-up script |
| `synthesisCheck` | `{coreConcept:string}` | one-time integrative check |
| `scenarioStage` | union | `prep` / `roleplay` / `wrapup` |

Optional `internalAssessment` is runtime-owned teaching state.

The old `applyPblEdit add_milestone` minted an `ms-...` id, set status `locked`,
set `order` to length + 1, and created an empty `microtasks` array. A generic
pointer does none of that automatically. Adding/reordering means supplying the
complete resulting array and maintaining ids/order/status yourself.

## Microtasks

Required fields:

| Field | Type | Legal values / meaning |
| --- | --- | --- |
| `id` | string | task identity |
| `title` | string | task title |
| `status` | union | `todo` / `in_progress` / `completed` / `skipped` |
| `assignee` | literal | exactly `user` in the current product |
| `hints` | `string[]` | learner help |
| `order` | number | 1-based authored ordering convention |

Optional authoring fields:

- `description: string`
- `completionCriteria: string`
- `successWhen: string`
- `characterObjective: string`
- `skillFocus: string`
- `narration: string`
- `learnerBrief: string`

Optional runtime fields:

- `internalAssessment`
- `completionReason`
- `engagement`

`successWhen` is a hidden, concrete observable advance criterion in scenario
projects. It is not learner-facing and is excluded from text search.

`characterObjective` is private character motivation. It must not be narrated,
evaluated as learner copy, or exposed in `learnerBrief`.

`learnerBrief` is pure display guidance and may fall back to `description` when
absent. It should orient without revealing `successWhen` or private character
facts.

The old `applyPblEdit add_microtask` minted `mt-...`, set `status:"todo"`,
`assignee:"user"`, empty hints, and order length + 1. Generic pointer writes do
not mint or normalize those fields.

## PBL documents

A milestone document is:

```json
{
  "id": "doc-1",
  "title": "Reference",
  "content": "...",
  "docType": "markdown"
}
```

`docType` legal values:

```text
markdown | reference | starter_file
```

The current generators do not author this legacy/future slot according to the
type comment. Treat inherited documents conservatively.

## Scenario package

Presence of `projectV2.scenario` marks a role-play scenario project.

Required:

- `setting: string`
- `characters: PBLScenarioCharacter[]`

Optional:

- `sceneVisual`
- `goal: string`
- `rules: string`
- `learnerRole: string`

A character requires `id`, `name`, and `persona`. Optional fields are
`situation`, `boundaries`, `avatar`, and `openingLine`.

`situation` is the character's concrete current circumstance and is distinct
from stable `persona`.

`boundaries` are hard safety limits.

Optional `sceneVisual` fields are `caption`, `bg1`, `bg2`, `accent`, and
`motifs:string[]`. The type comments describe colors as hex examples, but the
TypeScript fields are strings and rendering sanitizes malformed values. Do not
claim the write validator enforces hex.

## Runtime-owned arrays

### `submissions`

Learner work. A submission includes identity, task reference, kind, content,
and created time, with optional file metadata/summary.

Do not author or delete learner submissions while editing course design.

### `evaluations`

Instructor/evaluator feedback, scores, stars, and possible scenario act-goal
review. Runtime-owned.

### `threads`

Each thread has `agentId`, messages, and optional earlier summary. Messages are
conversation state. Do not use course editing to seed or rewrite learner chat.

### `engagementEvents` and `runtimeEvents`

Append-only ledgers. They are not content arrays and must not be reordered or
trimmed by an authoring patch.

### pending gates

`pendingHandover` and `pendingTaskCompletion` encode learner progress gates.
Changing them bypasses runtime operations and is out of scope for content
authoring.

## Visible text projection

`read_stage detail:"text"` includes:

- project title, description, learningObjective, and gains
- role name and learner-facing role description
- milestone title, description, briefing, and debrief
- microtask title, description, learnerBrief, and hints
- visible action text

It intentionally excludes:

- role `systemPrompt`
- `successWhen`
- `characterObjective`
- assessments, submissions, evaluations, threads, ledgers, and pending gates

Use `grep_stage scope:"source"` only when you intentionally need an internal
field. Source search can expose runtime/private data; do not echo it to learners.

## Pointer/application-layer impedance

The old PBL menu had semantic operations:

- `set_project`
- `set_role`
- `set_milestone`
- `set_microtask`
- add/delete milestone
- add/delete microtask

Those operations found records by id, minted ids for additions, renumbered
orders after deletion, and refreshed `updatedAt`.

`patch_stage` intentionally uses raw pointers instead. It addresses arrays by
current index and performs none of those PBL-specific repairs. This is the main
apply-layer impedance exposed by the spike.

Consequences:

- Fresh source is mandatory before every index write.
- Array additions/deletions require complete-array replacement.
- The caller owns id uniqueness, order normalization, statuses, thread seats,
  and updatedAt.
- The current validator proves containers, not every cross-reference.

## Common rejection reasons

- Pointer starts `/projectV2/...` instead of `/content/projectV2/...`.
- Intermediate `projectV2`, milestone, or task does not exist.
- Index is stale or out of bounds.
- Root content gains an unknown field.
- Core v2 containers are removed or cease to be arrays.
- `projectConfig` becomes a primitive.
- Scene/content discriminators no longer agree.

## Common semantic errors that may still persist

- Duplicate role/milestone/microtask ids.
- Orders have gaps or disagree with array order.
- First milestone remains locked when a new course expected it active.
- A role id changes but its thread `agentId` does not.
- Scenario fields leak private goals into learner-facing copy.
- Design edits overwrite submissions, evaluation, chat, or progress.
- A nested field is misspelled under the intentionally open historical project
  tree and the renderer silently ignores it.
- `updatedAt` is stale after a generic pointer write.

## Worked example 1: edit one milestone title

Read source:

```json
read_stage({
  "path": "/scenes/4",
  "detail": "source"
})
```

Locate by id, then note the current index:

```text
/content/projectV2/milestones/1/id = "ms-research"
/content/projectV2/milestones/1/title = "Research"
```

Patch the leaf:

```json
patch_stage({
  "target": "/scenes/4",
  "intent": "Make the research milestone outcome explicit",
  "ops": [
    {
      "op": "set",
      "path": "/content/projectV2/milestones/1/title",
      "value": "Research and choose one bridge design"
    }
  ]
})
```

Read source again. Confirm the same milestone id, status, order, and microtasks.

## Worked example 2: update learner brief without exposing hidden success

Read source and compare:

```text
/content/projectV2/milestones/1/microtasks/0/learnerBrief
/content/projectV2/milestones/1/microtasks/0/successWhen
```

Patch only the visible brief:

```json
patch_stage({
  "target": "/scenes/scene_pbl",
  "intent": "Clarify the learner-facing task orientation",
  "ops": [
    {
      "op": "set",
      "path": "/content/projectV2/milestones/1/microtasks/0/learnerBrief",
      "value": "Compare the two designs and explain which trade-off matters most."
    }
  ]
})
```

Read source and text. Verify `successWhen` is byte-identical and the new brief
appears in the visible projection.

## Worked example 3: change a role description, not its internal prompt

Read source and identify the role by id:

```text
/content/projectV2/roles/0/id = "role-instructor"
/content/projectV2/roles/0/description = "..."
/content/projectV2/roles/0/systemPrompt = "..."
```

Patch:

```json
patch_stage({
  "target": "/scenes/4",
  "intent": "Make the Instructor tooltip more reassuring",
  "ops": [
    {
      "op": "set",
      "path": "/content/projectV2/roles/0/description",
      "value": "I will help you break the project into manageable decisions."
    }
  ]
})
```

Read back. Confirm id, type, name, and `systemPrompt` are unchanged.

## Hard rules

- Treat project design and learner runtime state as separate ownership domains.
- Never edit submissions, evaluations, threads, ledgers, or pending gates as a
  course-authoring convenience.
- Find records by id in source, then patch the current index.
- Preserve ids and cross-references.
- Whole-array writes own normalization that the old semantic apply ops supplied.
- Do not rely on the tolerant PBL validator to catch nested misspellings.
- Read source and visible text back after every write.
