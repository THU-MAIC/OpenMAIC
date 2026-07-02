# @openmaic/dsl

The **contract keystone** of the MAIC SDK family. `@openmaic/dsl` is *pure spec* — the
slide object-model types, build-time JSON Schema artifacts, pure validators / type-guards,
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
| `action.ts`   | The playback verb set: `Action` and all variants (spotlight, laser, speech, the `Wb*` whiteboard family, `play_video`, `discussion`, and the `widget_*` interaction actions), `ActionType`, the frozen `ACTION_TYPES` set + `isActionType` guard, the `FIRE_AND_FORGET_ACTIONS` / `SLIDE_ONLY_ACTIONS` / `SYNC_ACTIONS` category lists, plus the `PercentageGeometry` overlay type. |
| `guards.ts`   | Pure discriminant type-guards (`isTextElement`, …) and `PPT_ELEMENT_TYPES`. |
| `validate.ts` | Pure, zero-dep structural validators — `validateStage` / `validateScene` / `validateAction` returning an error-collecting `ValidationResult`. |
| `version.ts`  | Serialized-contract version + migration registry: `DSL_VERSION`, the `DSL_MIGRATIONS` ladder, and the pure `migrate` / `dslVersionOf` / `needsMigration` runner. |

```ts
import type { Slide, PPTElement, Action } from '@openmaic/dsl';
import { isTextElement, DSL_VERSION, SYNC_ACTIONS } from '@openmaic/dsl';
```

## Runtime layer (schema + validators)

The contract is enforceable two ways — a zero-dependency in-process validator
and a cross-language JSON Schema — both generated from / aligned to the same
public TS types, and both honoring the zero-runtime-dependency invariant:

1. **JSON Schema artifacts (cross-language mirror)** — `Stage`, the default
   `Scene<Action, SceneContent>`, and `Action` are emitted as standalone JSON
   Schema at build time and shipped. This is the language-neutral mirror of the
   contract for non-TS consumers, and the place to go for exhaustive value-level
   (type / format) checking:

   ```ts
   import stageSchema from '@openmaic/dsl/schema/stage.schema.json' with { type: 'json' };
   import sceneSchema from '@openmaic/dsl/schema/scene.schema.json' with { type: 'json' };
   import actionSchema from '@openmaic/dsl/schema/action.schema.json' with { type: 'json' };
   // feed to any JSON Schema validator (ajv, or a non-TS / non-JS consumer)
   ```

   The schema is generated from the TS types (the single source of truth) by
   `ts-json-schema-generator`, a **devDependency** — it never enters the runtime
   dependency set.

2. **Pure validators (in-process boundary)** — `validate*` are hand-written,
   zero-dependency checks layered on the guards: object shape, required fields
   (including each action variant's, e.g. a `spotlight`'s `elementId`), known
   discriminants, and the scene `type` <-> `content` binding the public `Scene`
   type enforces. Because they add no dependency, in-process (TS / JS) producers
   and consumers — generators, importers, the runtime engine — can rely on them
   directly without shipping a schema validator. They are a structural subset of
   the schema (presence + discriminants; the schema additionally checks each
   field's value shape), and describe the same contract. Both are kept in lockstep
   by a test that pins the validators' per-variant required fields to the
   generated schema.

   ```ts
   import { validateStage, validateScene, validateAction } from '@openmaic/dsl';

   const result = validateScene(input);
   if (!result.valid) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
   ```

   `ValidationResult` is `{ valid: true } | { valid: false; errors: { path; message }[] }` —
   it collects every issue rather than failing on the first.

## Version & migration

Two version numbers live in this package and do **not** track each other:

- the **npm package version** (`package.json`) — the semver of the *code/API*
  artifact; bumps when exports or behavior change.
- **`DSL_VERSION`** — the version of the *serialized* slide contract (the
  on-disk document shape). It bumps only when a persisted document's shape
  changes, independent of package releases. (A third, finer axis —
  `SlideContent.schemaVersion` — versions the PPTist canvas *inside* a slide and
  is migrated app-side; it is orthogonal to `DSL_VERSION`.)

`version.ts` owns the document-level migration mechanism, zero-dependency and
pure like the validators:

```ts
import { DSL_VERSION, migrate, dslVersionOf, needsMigration } from '@openmaic/dsl';

const current = migrate(doc); // walks doc from its written version up to DSL_VERSION
```

- `DSL_MIGRATIONS` is an ordered ladder of `{ from, to, migrate }` steps; each
  step's `to` is the next step's `from`, and the last reaches `DSL_VERSION`.
- `migrate(doc)` reads the document's version from its `dslVersion` envelope
  field (absent ⇒ treated as legacy/unversioned), walks the ladder applying each
  pure transform, and stamps the result. It is **idempotent** (a current
  document is returned as-is), **forward-compatible** (a document stamped newer
  than `DSL_VERSION` is returned untouched, never silently downgraded), and
  **fail-loud** (a gap in the ladder throws rather than yielding a half-migrated
  document).

The first ladder entry is a no-op transform that stamps legacy documents up to
the current `DSL_VERSION`: promoting `Action` into the contract and adding
validators did not change any serialized shape, so the current on-disk shape
already *is* `0.1.0`. The entry wires the pipeline end to end and gives real
documents a version to migrate forward from; the first real transform is
appended (and `DSL_VERSION` bumped) when the serialized shape first changes.

Which aggregate carries the `dslVersion` field — a whole `Stage`, a single Scene
row, or a bundle — is left to the store that first consumes this pipeline; the
runner only needs the envelope field.

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
- [x] Add the JSON Schema for the slide contract + a pure schema validator
      (build-time `dist/schema/*.json` via a devDep generator; zero-dep
      `validate*` functions). See **Runtime layer** below.
- [x] Promote the `stage` / `scene` / `scene-content` types into the DSL (the
      universal skeleton now lives in `stage.ts`).
- [x] Bring the `Action` playback verb set into the DSL (`action.ts`); the
      widget interaction actions graduated into the contract once they decoupled
      from widget configs, so the standard `Action` union now covers them too.
      `Scene<TAction>` defaults to that union; PBL configs and the app's richer
      content kinds still plug in via `Scene`'s generics.
- [x] Activate the migration registry: `version.ts` ships the `DSL_MIGRATIONS`
      ladder and a pure `migrate` runner (idempotent, forward-compatible,
      fail-loud), no longer a stub. See **Version & migration** above.
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

Pure TypeScript compiled with `tsc` to ESM + `.d.ts`, then the JSON Schema
artifacts are generated into `dist/schema/`:

```bash
pnpm --filter @openmaic/dsl build         # -> dist/ (index.js, index.d.ts, …) + dist/schema/*.json
pnpm --filter @openmaic/dsl build:schema  # regenerate only dist/schema/*.json
pnpm --filter @openmaic/dsl typecheck
pnpm --filter @openmaic/dsl test
```

## License

MIT, matching the rest of the family (`@openmaic/dsl`, `@openmaic/importer`,
`@openmaic/renderer`) and the OpenMAIC root, so the license policy is uniform
across the SDK.
