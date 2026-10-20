# Native whiteboard shape tools (#1853)

`wb_draw_shape` supports existing rectangle/circle/triangle presets plus a
`custom` SVG path mode. Both modes accept optional `rotate` (finite degrees,
clockwise around the element center, default `0`), `fillColor` (default
`#5b9bd5`, including `transparent`), and
`stroke: { color, width, style? }` (positive width, style defaults to `solid`,
also `dashed`/`dotted`). Omitted stroke preserves the existing no-outline behavior.

Custom mode requires both a nonblank SVG `path` **d attribute** and positive
`viewBox: [width, height]`. It never accepts a complete SVG document. Presets
reject `path`/`viewBox` rather than giving them ambiguous precedence. Position
`x`/`y` is the upper-left corner of the **unrotated** box; element dimensions
scale viewBox coordinates independently. Use a matching aspect ratio to
preserve mathematical lengths. Close filled polygons with `Z`; for open curves,
request transparent fill and an explicit stroke.

For a 3–4–5 triangle, use `path: "M0 0 L4 0 L0 3 Z"`, `viewBox: [4, 3]`,
`width: 240`, `height: 180`. At `x: 100, y: 100`, its hypotenuse endpoints are
`(340,100)` and `(100,280)`. An outward square on that edge uses
`x: 160, y: 160, width: 300, height: 300, rotate: -36.86989765`.
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
| Native tool | Supports the extended schema and persists full shape elements. Rejects Legacy `elementId` or missing `expectedLastSeq`. |
| Legacy child action tool (`classroom-actions.ts`) | Preset-only schema with `additionalProperties: false`; execution also explicitly rejects Native fields before emitting an action. |
| Legacy JSON action parser (`call-agent.ts`) | Rejects custom mode, rotation, path/viewBox, stroke and Native sequence fields, returning an action warning. |
| ActionEngine (including persisted playback/eval actions) | Rejects unsupported shape extensions and unknown shape names **before opening/creating a board**. Keeps supported preset playback unchanged. |
| SDK/current whiteboard rendering | Reads existing shape fields, so no new storage schema is required. |

Do not convert Native calls into Legacy JSON actions. Native mutations emit
projection hints, never draw actions that an older ActionEngine might
misinterpret. Older Native strict schemas reject added fields/custom mode.
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
The five cases cover a 3–4–5 triangle and hypotenuse square, a pentagon, an open
stroked curve, all three ordinary presets, and error recovery. Recovery injects
`M0 0 Z1 1` into the first otherwise valid custom call; the model receives the
real error and must retry. This is an intentional fault, not a generation error.
Runs stop after 24 recorded calls or 120 seconds. Results and raw traces go to the ignored `results/report.json`.
Publish observed results, logs and screenshots in PR comments; do not commit
run artifacts.
