# @maic/dsl

The **contract keystone** of the MAIC SDK family. `@maic/dsl` is *pure spec* — the
slide object-model types, (planned) JSON Schema, pure validators / type-guards,
and version/migration helpers — with **zero runtime dependencies** (no React, no
pptx, no echarts).

That purity is the whole point: the renderer, the importer, and any future
package can depend on `@maic/dsl` without pulling in junk.

## Dependency arrows (acyclic)

```
@maic/dsl       ->  (nothing)
@maic/renderer  ->  @maic/dsl
@maic/importer  ->  @maic/dsl
@maic/exporter  ->  @maic/dsl     (reserved, future)
```

`@maic/dsl` is the only package everything else depends on, and it depends on
nothing.

## What's in here

| Module        | Contents                                                            |
| ------------- | ------------------------------------------------------------------- |
| `slides.ts`   | The slide object model: `Slide`, `PPTElement` and all variants, theme, background, animation, table/chart/code types, plus `ElementTypes` / `ShapePathFormulasKeys` enums. |
| `stage.ts`    | The lesson skeleton: `Stage`, generic `Scene<TAction, TContent>`, `SceneType`, `StageMode`, `Whiteboard`, `VideoManifest`, `SlideContent`, `QuizContent`, `MultiAgentConfig`, `GeneratedAgentConfig`, plus `isSlideContent` / `isQuizContent` guards. |
| `guards.ts`   | Pure discriminant type-guards (`isTextElement`, …) and `PPT_ELEMENT_TYPES`. |
| `version.ts`  | `DSL_VERSION` + the `DslMigration` shape and (empty) migration registry. |

```ts
import type { Slide, PPTElement } from '@maic/dsl';
import { isTextElement, DSL_VERSION } from '@maic/dsl';
```

## Status

Both consumers are now wired to `@maic/dsl` and no longer vendor their own copy
of the slide types:

- **`@maic/importer`**: imports all slide types from `@maic/dsl`; vendored
  `openmaic/types/slides.ts` deleted. The importer emits complete DSL `Slide`
  objects directly (the old partial "draft slide" + post-fill step is gone).
- **`@maic/renderer`**: imports all slide types from `@maic/dsl`; vendored
  `types/slides.ts` deleted. `@maic/dsl` is a regular dependency, kept external
  in the rollup build so consumers share one copy. The public
  `@maic/renderer/types` surface now re-exports the DSL types.

### Roadmap

- [x] Wire `@maic/importer` to import types from `@maic/dsl` (vendored copy deleted).
- [x] Wire `@maic/renderer` to import types from `@maic/dsl` (vendored copy deleted).
- [ ] Add the JSON Schema for the slide contract + a pure schema validator.
- [x] Promote the `stage` / `scene` / `scene-content` types into the DSL (the
      universal skeleton now lives in `stage.ts`; `Action`, Ultra-mode widgets,
      and PBL stay app-side and plug in via `Scene<TAction, TContent>`).
- [ ] Reserve `@maic/exporter` as the 4th family member.

### Stage / Scene split

`stage.ts` owns only the **universal lesson skeleton**: `Stage`, the
discriminated `SceneContent` (`SlideContent | QuizContent`), and a generic

```ts
interface Scene<TAction = never, TContent extends { type: SceneType } = SlideContent | QuizContent>
```

so the contract carries no dependency on the playback action set or the richer
feature surfaces. Apps compose their full scene type by injecting their own
types:

```ts
import type { Scene } from '@maic/dsl';
type AppScene = Scene<AppAction, SlideContent | QuizContent | InteractiveContent | PBLContent>;
```

`Action`, widget configs (`WidgetType` / `WidgetConfig`), and `PBLProjectConfig`
are deliberately out of scope here — they're faster-moving product surfaces and
may graduate to sibling packages (`@maic/actions`, …) later.

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
pnpm --filter @maic/dsl build      # -> dist/ (index.js, index.d.ts, …)
pnpm --filter @maic/dsl typecheck
```

## License

AGPL-3.0, matching the rest of the family (`@maic/dsl`, `@maic/importer`,
`@maic/renderer`) and the OpenMAIC root, so the license policy is uniform
across the SDK.
