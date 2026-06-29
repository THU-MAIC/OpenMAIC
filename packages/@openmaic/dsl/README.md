# @openmaic/dsl

The **contract keystone** of the MAIC SDK family. `@openmaic/dsl` is *pure spec* — the
slide object-model types, (planned) JSON Schema, pure validators / type-guards,
and version/migration helpers — with **zero runtime dependencies** (no React, no
pptx, no echarts).

That purity is the whole point: the renderer, the importer, and any future
package can depend on `@openmaic/dsl` without pulling in junk.

## Dependency arrows (acyclic)

```
@openmaic/dsl       ->  (nothing)
@openmaic/renderer  ->  @openmaic/dsl
@openmaic/importer  ->  @openmaic/dsl
@openmaic/exporter  ->  @openmaic/dsl     (reserved, future)
```

`@openmaic/dsl` is the only package everything else depends on, and it depends on
nothing.

## What's in here

| Module        | Contents                                                            |
| ------------- | ------------------------------------------------------------------- |
| `slides.ts`   | The slide object model: `Slide`, `PPTElement` and all variants, theme, background, animation, table/chart/code types, plus `ElementTypes` / `ShapePathFormulasKeys` enums. |
| `stage.ts`    | The lesson skeleton: `Stage`, generic `Scene<TAction, TContent>`, `SceneType`, `StageMode`, `Whiteboard`, `VideoManifest`, `SlideContent`, `QuizContent`, `MultiAgentConfig`, `GeneratedAgentConfig`, plus `isSlideContent` / `isQuizContent` guards. |
| `action.ts`   | The playback verb set: `Action` and all variants (spotlight, laser, speech, the `Wb*` whiteboard family, `play_video`, `discussion`, and the `widget_*` interaction actions), `ActionType`, the `FIRE_AND_FORGET_ACTIONS` / `SLIDE_ONLY_ACTIONS` / `SYNC_ACTIONS` category lists, plus the `PercentageGeometry` overlay type. |
| `guards.ts`   | Pure discriminant type-guards (`isTextElement`, …) and `PPT_ELEMENT_TYPES`. |
| `version.ts`  | `DSL_VERSION` + the `DslMigration` shape and (empty) migration registry. |

```ts
import type { Slide, PPTElement, Action } from '@openmaic/dsl';
import { isTextElement, DSL_VERSION, SYNC_ACTIONS } from '@openmaic/dsl';
```

## Status

Both consumers are now wired to `@openmaic/dsl` and no longer vendor their own copy
of the slide types:

- **`@openmaic/importer`**: imports all slide types from `@openmaic/dsl`; vendored
  `openmaic/types/slides.ts` deleted. The importer emits complete DSL `Slide`
  objects directly (the old partial "draft slide" + post-fill step is gone).
- **`@openmaic/renderer`**: imports all slide types from `@openmaic/dsl`; vendored
  `types/slides.ts` deleted. `@openmaic/dsl` is a regular dependency, kept external
  in the rollup build so consumers share one copy. The public
  `@openmaic/renderer/types` surface now re-exports the DSL types.

### Roadmap

- [x] Wire `@openmaic/importer` to import types from `@openmaic/dsl` (vendored copy deleted).
- [x] Wire `@openmaic/renderer` to import types from `@openmaic/dsl` (vendored copy deleted).
- [ ] Add the JSON Schema for the slide contract + a pure schema validator.
- [x] Promote the `stage` / `scene` / `scene-content` types into the DSL (the
      universal skeleton now lives in `stage.ts`).
- [x] Bring the `Action` playback verb set into the DSL (`action.ts`); the
      widget interaction actions graduated into the contract once they decoupled
      from widget configs, so the standard `Action` union now covers them too.
      `Scene<TAction>` defaults to that union; PBL configs and the app's richer
      content kinds still plug in via `Scene`'s generics.
- [ ] Reserve `@openmaic/exporter` as the 4th family member.

### Stage / Scene split

`stage.ts` owns the **universal lesson skeleton**: `Stage`, the discriminated
`SceneContent` (`SlideContent | QuizContent`), and a generic

```ts
interface Scene<TAction = Action, TContent extends { type: SceneType } = SlideContent | QuizContent>
```

`TAction` defaults to the contract's standard `Action` union (defined in
`action.ts`), so a scene carries playback actions out of the box; skeleton-only
consumers that reject actions opt out with `Scene<never, …>`. Apps widen the
content union (and, if they add their own actions, the action union) by
injecting their own types:

```ts
import type { Scene, Action } from '@openmaic/dsl';
type AppScene = Scene<Action, SlideContent | QuizContent | InteractiveContent | PBLContent>;
```

Widget *configs* (`WidgetType` / `WidgetConfig`) and `PBLProjectConfig` remain
out of scope here — they're faster-moving product surfaces that stay app-side
and plug in via `Scene`'s generics. The widget *actions* (`widget_highlight`,
`widget_setState`, …), by contrast, are config-free playback verbs and live in
`action.ts` with the rest of the `Action` union.

## Divergence reconciled (seed provenance)

The seed is the app's `lib/types/slides.ts`, but before this package existed the
contract had been copy-pasted into three places that **drifted apart**. This
package is the **canonical superset**: every field that existed in any copy is
kept, so consumers can adopt the DSL without losing data. Merged-in fields are
annotated `@since-merge` in `slides.ts`.

| Field                                   | app `lib/types` | renderer copy | importer copy | DSL decision |
| --------------------------------------- | :-------------: | :-----------: | :-----------: | ------------ |
| `PPTTextElement.vAlign`                 |        —        |       ✓       |       ✓       | kept |
| `PPTImageElement.softEdge`              |        —        |       ✓       |       ✓       | kept |
| `TableCellBorder` + `TableCell.borders` |        —        |       ✓       |       ✓       | kept |
| `TableCell.padding`                     |        —        |       ✓       |       ✓       | kept |
| `TableCell.vAlign`                      |        —        |  `top/middle/bottom`  | `up/mid/down/top/middle/bottom` | canonical = `top/middle/bottom`; importer already normalizes its `up/mid/down` aliases in `transformParsedToSlides` |
| `PPTTableElement.rowHeights`            |        —        |       ✓       |       ✓       | kept |
| `Slide.script` (speaker notes)          |        —        |       —       |       ✓       | kept |
| `Slide.viewportSize/viewportRatio/theme`|    required     |   required    |   optional    | canonical = **required**; importer now fills them at construction in `transformParsedToSlides` (no partial/draft stage) |
| `SlideData` (deprecated)                |        ✓        |       —       |       ✓       | kept, `@deprecated` |

The importer conforms to the canonical contract: it normalizes cell `vAlign`
aliases and emits the required `Slide` fields on output. The renderer consumes
the same superset (it gains access to `script` and the importer-origin fields it
didn't previously declare).

## Build

Pure TypeScript compiled with `tsc` to ESM + `.d.ts`:

```bash
pnpm --filter @openmaic/dsl build      # -> dist/ (index.js, index.d.ts, …)
pnpm --filter @openmaic/dsl typecheck
```

## License

MIT, matching the rest of the family (`@openmaic/dsl`, `@openmaic/importer`,
`@openmaic/renderer`) and the OpenMAIC root, so the license policy is uniform
across the SDK.
