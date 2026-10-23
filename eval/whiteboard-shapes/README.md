# Native whiteboard shape tools (#1853)

`wb_draw_shape` uses one SVG path interface for every shape. There is no
`shape` discriminator or rectangle/circle/triangle preset mode. It accepts
optional `rotate` (finite degrees,
clockwise around the element center, default `0`), `fillColor` (default
`#5b9bd5`, including `transparent`), and
`stroke: { color, width, style? }` (positive width, style defaults to `solid`,
also `dashed`/`dotted`). Omitted stroke preserves the existing no-outline behavior.

Every call requires both a nonblank SVG `path` **d attribute** and positive
`viewBox: [width, height]`. It never accepts a complete SVG document. Position
`x`/`y` is the upper-left corner of the **unrotated** box; element dimensions
scale viewBox coordinates independently. Use a matching aspect ratio to
preserve mathematical lengths. Plan a rotated shape's center first, then set
`x = centerX - width / 2`, `y = centerY - height / 2`. Arc radii are expressed
in viewBox units and scale with the element dimensions. Close filled shapes with `Z`; for open curves,
request transparent fill and an explicit stroke.

Path coordinates are local: `(0,0)` is the unrotated element's upper-left.
Do not put absolute whiteboard coordinates into the path or center it around
zero without offsetting it into the viewBox.

| Shape | Path | viewBox |
| --- | --- | --- |
| Rectangle | `M0 0 H1 V1 H0 Z` | `[1,1]` |
| Isosceles triangle | `M1 0 L2 1 L0 1 Z` | `[2,1]` |
| Circle / ellipse | `M1 0 A1 1 0 1 1 1 2 A1 1 0 1 1 1 0 Z` | `[2,2]` |
| Clockwise upper-right quarter circle | `M0 0 A1 1 0 0 1 1 1` | `[1,1]` |

For a circle, use equal element width/height; unequal dimensions give an
ellipse. The quarter-circle example runs from the top-left to the bottom-right
of its box. With equal width/height, its radius equals the element width,
not half the width. Use transparent fill and an explicit stroke for this arc.

For a 3–4–5 triangle, use `path: "M0 0 L4 0 L0 3 Z"`, `viewBox: [4, 3]`,
and `width:height = 4:3` to preserve its proportions.
For a curve, use `path: "M0 1 C1 0 2 0 3 1"`, `viewBox: [3, 1]`,
`fillColor: "transparent"`, `stroke: { color: "#333333", width: 2 }`.
In **every actual call**, copy `nextMutation.expectedLastSeq` exactly from the
latest `wb_read`. Read again between successful mutations. These examples
omit the sequence deliberately; `null` is valid only when the read returns null.

## Validation and persistence

Both preparation and direct execution validate before appending or creating a
session. `@openmaic/geometry` supplies the shared grammar, numeric, scaled-bounds,
and resource checks from #1851. Input limits are 100,000 path code units,
10,000 commands, and coordinate/dimension magnitudes up to 1,000,000.
Malformed or excessive input returns an error the model can correct; direct
execution returns `INVALID_WHITEBOARD_SHAPE` with an error field/code and
character position where available. There is no rectangle fallback.

The tool constructs existing `PPTShapeElement` fields (`path`, `viewBox`,
`rotate`, `fill`, `outline`) and appends the existing `element_added` event.
Operation/element identity remains host-owned, with unchanged CAS, sequence,
exact-replay and projection behavior. No DSL or runtime payload version change
is needed. Unit tests reopen BrowserRuntimeStore, replay after a later write,
retain old preset records, and verify rejected input leaves no sessions or
projection events. Historical reads retain the renderer's separate, more
permissive render budget; new producer limits do not invalidate old records.

Current whiteboard playback re-exports the SDK's `BaseShapeElement`. Tests
compare both rendering entries for path, scale, angle, transparent fill and
stroke. Existing worker tests bound malformed historical rendering.

## Legacy and cross-version compatibility

| Entry | Behavior |
| --- | --- |
| Native tool | Requires path/viewBox and persists full shape elements. Rejects the removed `shape` discriminator, Legacy `elementId`, or missing `expectedLastSeq`. |
| Legacy child action tool (`classroom-actions.ts`) | Preset-only schema with `additionalProperties: false`; execution also explicitly rejects Native fields before emitting an action. |
| Legacy JSON action parser (`call-agent.ts`) | Rejects custom mode, rotation, path/viewBox, stroke and Native sequence fields, returning an action warning. |
| ActionEngine (including persisted playback/eval actions) | Rejects unsupported shape extensions and unknown shape names **before opening/creating a board**. Keeps supported preset playback unchanged. |
| SDK/current whiteboard rendering | Reads existing shape fields, so no new storage schema is required. |

Do not convert Native calls into Legacy JSON actions. Native mutations emit
projection hints, never draw actions that an older ActionEngine might
misinterpret. Historical elements already store path/viewBox/rotation, so they
remain readable without migration. New Native calls must omit `shape` and
supply path/viewBox; older Native preset/custom arguments fail explicitly.
Older Native strict schemas reject the new path-only arguments.
Unpatched historical Legacy executors can discard rotation or turn custom
shapes into rectangles; they cannot safely execute this new interface. Use the
Native tool/projection path, or upgrade the executor to get the explicit
rejections above. This change does not claim that old binaries negotiate new
capabilities automatically.

## Live evaluation

Run with configured, authorized model IDs and credentials:

```sh
node --env-file=.env.local --conditions=import --import tsx \
  eval/whiteboard-shapes/runner.ts \
  --models openai:gpt-5.6-sol,openai:gpt-5.6-luna
```

The runner uses the production Native prompt, Pi agent and tool executors with
an isolated BrowserRuntimeStore. Browser visibility is settled in-process;
this is a tool/geometry eval, not an HTTP-route or full classroom UI test.
The cases cover a 3–4–5 triangle and hypotenuse square, a pentagon, an open
stroked curve, ordinary shapes drawn through paths, and error recovery. Recovery injects
`M0 0 Z1 1` into the first otherwise valid custom call; the model receives the
real error and must retry. This is an intentional fault, not a generation error.
The additional `composition` case requests a 5–12–13 triangle and outward squares
on all three sides. Its task gives only the triangle vertices, not square
coordinates, paths, rotation angles or a construction recipe. Four fixed variants
change scale, position and orientation; repetitions cycle through them. Scoring
checks all four closed contours after viewBox scaling and rotation, with a 1 px
vertex tolerance and correct edge order, exterior placement and canvas bounds.
Separate elements and compound paths are both accepted. Missing, duplicate, extra,
invisible or malformed contours fail. Hand-computed fixtures cover known correct
and incorrect compositions independently of the reference-square generator.
Filled scenarios require a valid static color with nonzero alpha and element
opacity; SVG `none` and zero-alpha colors do not count as visible fills. The curve
case checks one open cubic contour, its unrotated box and rotation, and a visible
dark 2px stroke, rather than treating the presence of `C` in a path as sufficient.

For a small composition batch:

```sh
node --env-file=.env.local --conditions=import --import tsx \
  eval/whiteboard-shapes/runner.ts --models deepseek:deepseek-flash \
  --cases composition --repetitions 12 --output /tmp/whiteboard-composition
```

The runner uses production `runNativeChild`, with thinking enabled, a 4,096 output
token limit, 5 provider transports and a 60-second timeout by default. Options
`--thinking enabled|disabled`, `--max-provider-transports N` and `--timeout-ms N`
make the budget explicit. A diagnostic run with `--max-provider-transports 12`
can separate geometry failures from insufficient requests for several sequential
read/mutation pairs; it is not a production-budget completion score. No production
runtime limits are changed. `--cases all` runs every case (the default); comma-separated
case IDs and `--repetitions N` select a subset and repeat it.

Results include the exact system/task prompts, Native stop reason, geometry
assessment, persisted shapes and tool traces. A run passes only if the Native child
completes and the persisted geometry is correct. Reports go to `results/report.json`
and one JSON file per trial by default, all ignored by Git.
Publish observed results, logs and screenshots in PR comments; do not commit
run artifacts.
