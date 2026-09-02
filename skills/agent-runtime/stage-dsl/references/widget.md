# Interactive and widget field reference

This chapter describes `scene.content` when `scene.type` is `interactive`.

The fields come from the shared interactive contract, the app's six
`WidgetConfig` variants, `applyWidgetEdit`, and `validateAppScene`.

## Interactive content root

```json
{
  "type": "interactive",
  "html": "<!doctype html>...",
  "widgetType": "simulation",
  "widgetConfig": {
    "type": "simulation"
  }
}
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | string | yes | exactly `interactive`; must match `scene.type` |
| `html` | string | conditionally | complete HTML document rendered with iframe `srcDoc` |
| `url` | string | conditionally | iframe `src` fallback used when `html` is absent |
| `widgetType` | widget-type union | no | historical/top-level widget discriminator |
| `widgetConfig` | object | no | typed Ultra-mode widget configuration |

At least one of `html` or `url` must be present as a string. The empty string is
still a string and is accepted for historical documents.

When both are present, the contract documents `html` as the `srcDoc` source and
`url` as the fallback when HTML is absent.

`patch_stage` closes the content root to the five fields above. The existing
document validator intentionally remains tolerant inside `widgetConfig` for
historical stored shapes. Type declarations below are therefore stronger than
the current runtime write barrier below that root.

## Widget discriminator

Legal widget types are:

```text
simulation
diagram
code
game
visualization3d
procedural-skill
```

The shared `WidgetConfigBase` requires `type` but permits app-defined extension
fields. The app TypeScript union supplies the field sets below.

`applyWidgetEdit` preserves the existing config type when merging `set_config`:
it chooses `widgetConfig.type`, falling back to `widgetType`. A raw pointer can
write either discriminator independently. Keep all present discriminators
consistent yourself.

## `simulation`

Required fields in the app type:

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"simulation"` | discriminator |
| `concept` | string | concept being simulated |
| `description` | string | learner-facing explanation |
| `variables` | `SimulationVariable[]` | adjustable numeric inputs |

A simulation variable is:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | state key |
| `label` | string | yes | learner-facing label |
| `min` | number | yes | lower bound |
| `max` | number | yes | upper bound |
| `default` | number | yes | initial value |
| `unit` | string | no | displayed unit |
| `step` | number | no | control increment |

Optional `presets` is an array of:

```json
{
  "name": "Heavy object",
  "variables": { "mass": 10 }
}
```

The type does not state that default lies between min and max, that step is
positive, or that every preset key names a declared variable. Those are
semantic responsibilities.

## `diagram`

| Field | Type | Required | Legal values / meaning |
| --- | --- | --- | --- |
| `type` | `"diagram"` | yes | discriminator |
| `diagramType` | string union | yes | `flowchart` / `mindmap` / `hierarchy` / `system` |
| `description` | string | yes | learner-facing explanation |
| `nodes` | `DiagramNode[]` | yes | diagram vertices |
| `edges` | `DiagramEdge[]` | yes | directed connections |
| `revealOrder` | `string[]` | no | node ids in reveal sequence |

A node:

| Field | Type | Required | Values |
| --- | --- | --- | --- |
| `id` | string | yes | node identity |
| `label` | string | yes | visible label |
| `position` | `{x:number,y:number}` | no | explicit position |
| `details` | string | no | extra description |
| `type` | string union | no | `default` / `decision` / `start` / `end` |

An edge requires string `id`, `from`, and `to`; `label` is optional.

The type does not prove that edge endpoints or reveal ids exist in `nodes`.

## `code`

| Field | Type | Required | Legal values / meaning |
| --- | --- | --- | --- |
| `type` | `"code"` | yes | discriminator |
| `language` | string union | yes | `python` / `javascript` / `typescript` / `java` / `cpp` |
| `description` | string | yes | task explanation |
| `starterCode` | string | yes | learner's initial program |
| `testCases` | `CodeTestCase[]` | yes | evaluator cases |
| `hints` | `string[]` | yes | learner help |
| `solution` | string | yes | reference solution |

A test case requires string `id`, `input`, and `expected`. Optional fields are
string `description` and boolean `isHidden`.

`solution`, hidden expected results, and hidden tests are source data, not
visible-text search content. Use `grep_stage scope:"source"` to find them.

The current write barrier does not enforce that test-case ids are unique or
that code parses in the selected language.

## `game`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"game"` | yes | discriminator |
| `gameType` | string union | yes | `quiz` / `puzzle` / `strategy` / `card` |
| `description` | string | yes | learner-facing game description |
| `questions` | `GameQuestion[]` | no | quiz-like game content |
| `scoring` | object | yes | scoring controls |
| `achievements` | object array | no | named unlock conditions |

A game question requires `id`, `question`, `type`, `options`, and `correct`.

Question `type` is `single` or `multiple`.

`options` is `string[]`.

`correct` is a number or number array. The type does not state whether the
number is zero-based, one-based, or an option id. Do not guess: read a working
neighboring game and preserve its convention.

Optional question fields are string `explanation` and number `points`.

`scoring.correctPoints` is required. Optional numeric fields are `speedBonus`,
`comboMultiplier`, and `penalty`.

An achievement requires string `id`, `name`, `description`, `icon`, and
`condition`. The meaning/language of `condition` is not specified by the type.

## `visualization3d`

Required root fields:

| Field | Type | Values |
| --- | --- | --- |
| `type` | literal | `visualization3d` |
| `visualizationType` | union | `molecular` / `solar` / `anatomy` / `geometry` / `physics` / `custom` |
| `description` | string | learner-facing description |
| `objects` | object array | scene objects |

Each object requires `id` and a type from:

```text
sphere | box | cylinder | cone | torus | plane | custom
```

Optional object fields:

- `name: string`
- `position: {x,y,z}`
- `rotation: {x,y,z}`
- `scale: number | {x,y,z}`
- `children: Visualization3DObject[]`
- `material`
- `animation`

Material `type` is `basic`, `lambert`, `phong`, `standard`, or `emissive`.
Optional material fields are `color`, `emissive`, `wireframe`, `transparent`,
and `opacity` with their obvious string/boolean/number types. Numeric ranges
are not specified.

Animation `type` is `orbit`, `rotate`, `bounce`, or `pulse`; optional `speed`
is a number and optional `axis` is `x`, `y`, or `z`.

Optional root `interactions` use a type from:

```text
orbit | zoom | pan | slider | button | toggle
```

They may carry `target`, `label`, `param`, and numeric `min`, `max`, `default`,
`step`.

Optional `camera` has numeric-vector `position`, `target`, and number `fov`.

Optional `lighting` has ambient, directional, and point lights. Color is a
string; intensity is a number; positioned lights may carry `{x,y,z}`.

Optional presets carry string `name`, optional string `description`, and open
`state: Record<string, unknown>`.

Renderer interpretation, units, coordinate handedness, and supported custom
object payload are not specified by these types. Read renderer code before
inventing values outside a working example.

## `procedural-skill`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"procedural-skill"` | yes | discriminator |
| `task` | string | yes | overall learner task |
| `description` | string | yes | task explanation |
| `tools` | `string[]` | no | named tools/resources |
| `steps` | `ProceduralSkillStep[]` | yes | ordered procedure |
| `successCriteria` | `string[]` | no | overall completion criteria |

A step requires string `id`, `title`, and `description`. Optional fields are
`tools: string[]` and `successCriteria: string[]`.

The type does not enforce that step tool names appear in root `tools`, that ids
are unique, or that success criteria are machine-checkable.

## HTML branch

`html` is a complete document string, not the slide rich-text dialect.

The shared contract says it is rendered through iframe `srcDoc`.

`patch_stage` stores the string supplied after structural validation. It does
not call `applyHtmlEdits`; generic pointer `set` replaces the exact string.

`read_stage detail:"text"` removes script/style blocks and tags, collapses
whitespace, and searches the remaining text. It is a projection, not a browser
render or sanitizer.

Security policy, iframe sandbox flags, CSP, script execution, and network
access are not established by the data types. Do not infer them from this
chapter.

## Large HTML and long text: use str_replace, not whole-field set

A 27 KB interactive document should not be rewritten with `set`: repeating
the whole string is expensive, and any transcription error silently corrupts
the page. For one targeted change, replace only the exact anchor inside the
stored string.

1. Read `detail:"source"` and locate the exact snippet in `/content/html`.
2. `patch_stage` with `op:"str_replace"` and a short unique anchor.
3. Read `detail:"source"` again, then `grep_stage` to verify the change and
   that no residue remains.

Example: slow a gravity simulation by editing one constant inside a 27 KB
document:

```json
read_stage({
  "path": "/scenes/3",
  "detail": "source"
})
```

Locate in the source:

```text
/content/html contains "const speed = 0.015 * dt"
```

Patch the one occurrence:

```json
patch_stage({
  "target": "/scenes/3",
  "intent": "Slow the gravity simulation",
  "ops": [
    {
      "op": "str_replace",
      "path": "/content/html",
      "oldText": "const speed = 0.015 * dt",
      "newText": "const speed = 0.006 * dt"
    }
  ]
})
```

Verify by reading `detail:"source"` again, then `grep_stage` for `0.015`
(expect no hit) and `0.006` (expect one hit).

The anchor must occur exactly once in the stored string. On zero hits the
patch is rejected with the count; on several hits, extend the anchor or set
`replaceAll:true`. `newText` may be the empty string to delete the anchor.
Neither `oldText` nor `newText` may contain a read-side media omission
placeholder. Use `set` only when the whole string genuinely changes.

## Common pitfalls

- `widgetType` and `widgetConfig.type` disagree.
- A pointer begins `/widgetConfig/...` instead of `/content/widgetConfig/...`.
- A config type is changed without replacing the variant-specific fields.
- A simulation default lies outside its range.
- Diagram edges point at missing node ids.
- Game `correct` uses a guessed indexing convention.
- Hidden code-test data is expected to appear in text search.
- A whole config object is rewritten and drops unknown historical fields.
- TypeScript says a field is required, but the historical runtime validator is
  permissive below `widgetConfig`; an accepted incomplete config then fails in
  a renderer. Acceptance is not proof of semantic completeness.

## Worked example 1: change simulation guidance

Read source:

```json
read_stage({
  "path": "/scenes/scene_widget",
  "detail": "source"
})
```

Locate:

```text
/content/widgetConfig/type = "simulation"
/content/widgetConfig/description = "Change the mass"
```

Patch the leaf:

```json
patch_stage({
  "target": "/scenes/scene_widget",
  "intent": "Clarify how to operate the simulation",
  "ops": [
    {
      "op": "set",
      "path": "/content/widgetConfig/description",
      "value": "Drag the mass slider and compare the acceleration."
    }
  ]
})
```

Read source again and verify that `type`, `variables`, and presets are unchanged.

## Worked example 2: adjust one simulation bound

Read source and identify the variable index by its `name`:

```text
/content/widgetConfig/variables/0/name = "mass"
/content/widgetConfig/variables/0/max = 10
```

Patch:

```json
patch_stage({
  "target": "/scenes/3",
  "intent": "Extend the mass experiment range",
  "ops": [
    {
      "op": "set",
      "path": "/content/widgetConfig/variables/0/max",
      "value": 20
    }
  ]
})
```

Read back and also check that `default <= max`; the validator does not check it.

## Worked example 3: replace the HTML document

Read source first and confirm this scene uses `html` rather than only `url`.

Patch the exact document string:

```json
patch_stage({
  "target": "/scenes/3",
  "intent": "Replace the interactive document copy",
  "ops": [
    {
      "op": "set",
      "path": "/content/html",
      "value": "<!doctype html><html><body><main>New activity</main></body></html>"
    }
  ]
})
```

Read `detail:"source"` to verify exact bytes, then `detail:"text"` to verify
that `New activity` is visible in the projection.

## Hard rules

- Keep the content and widget discriminators consistent.
- Patch leaves; do not replace a config merely to change one label.
- Treat the app TypeScript union as the authoring contract even where the
  historical write validator is tolerant.
- Use source search for hidden tests, solutions, ids, and state.
- Read back after every write.
