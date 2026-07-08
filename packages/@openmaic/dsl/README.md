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
| `normalize.ts` | Pure, zero-dep defaulters — `normalizeElement` / `normalizeSlide` / `normalizeScene` / `normalizeStage` and the canonical `ELEMENT_DEFAULTS`. Fills required-field defaults, derives geometry, fails loud on malformed input; the repair counterpart to `validate*`. `normalizeSlideWith({ onInvalid: 'drop', onDropped })` builds a map-safe `normalizeSlide` variant so producers normalizing wild-world input (imported decks, model output) can degrade per element instead of failing the document; `normalizeSlide` itself stays unary (`slides.map(normalizeSlide)` keeps working). |
| `version.ts`  | Serialized-contract version + migration registry: `DSL_VERSION`, the `DSL_MIGRATIONS` ladder, and the pure `migrate` / `dslVersionOf` / `needsMigration` runner. |

```ts
import type { Slide, PPTElement, Action } from '@openmaic/dsl';
import { isTextElement, DSL_VERSION, SYNC_ACTIONS } from '@openmaic/dsl';
```

## Runtime layer (schema + validators + normalizers)

The contract is enforceable two ways — a zero-dependency in-process validator
and a cross-language JSON Schema — both generated from / aligned to the same
public TS types, and both honoring the zero-runtime-dependency invariant; a
third zero-dependency `normalize*` family repairs a document to satisfy them:

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

3. **Pure normalizers (repair boundary)** — where `validate*` *reports* on a
   document, `normalize*` *repairs* one, so producers stop carrying their own
   imperative "fix up the output" pass. `normalizeElement` (and the
   `normalizeSlide` / `normalizeScene` / `normalizeStage` walkers) fill the
   required fields a producer may have left off, derive geometry-dependent fields
   (a line's `start` / `end`, a shape's `viewBox` / `path`), and **fail loud** on
   a present-but-wrong-typed field — returning a fully-defaulted document that
   then satisfies the validators. Pure and non-mutating; idempotent.

   The *static* defaults (`ELEMENT_DEFAULTS`) are the single source of truth and
   also ride out on the JSON Schema as `@default` annotations (so non-TS
   consumers ship them too); a test pins the two together. `normalize*` owns only
   the producer-independent defaults — media-specific reconciliation (e.g.
   fitting an image box to a resolved asset's real dimensions) stays a producer
   concern.

   Scope: `normalize*` owns element **content** (the per-variant required fields
   + derivable geometry). It does **not** fill or check the base identity /
   geometry every element shares (`id`, `left` / `top` / `width` / `height` /
   `rotate`) — those are producer-supplied (the `id` is often assigned
   downstream) and carry no content default. `normalize*` and `validate*` are
   complementary: normalize repairs content, validate / the schema check the
   full structure.

   ```ts
   import { normalizeElement, normalizeScene, ELEMENT_DEFAULTS } from '@openmaic/dsl';

   const el = normalizeElement(rawElement); // required fields filled, geometry derived
   const scene = normalizeScene(rawScene); //  walks the slide canvas + whiteboards
   ```

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

## Runtime envelope (#869)

Learner-produced runtime data (chat, quiz attempts, playback facts) is persisted
outside the document, per learner, through a `RuntimeStore` (`@openmaic/storage`).
This package owns the envelope: `RuntimeSession` (identity + lifecycle, keyed by
stage/learner/kind) and `RuntimeRecord<TPayload>` (ordered facts; the
store-assigned `seq` is the replay ordering key). Core-kind payload skeletons
(`chat`, `quizAttempt`) live here; payload internals are app-owned, validated at
the store boundary via injected validators (`runtime.ts` guards + `validate.ts`).
A `RuntimeSession` carries its **own** version envelope field,
`runtimeDslVersion` — mechanically disjoint from a document's `dslVersion` — and
rides its **own** version line: `RUNTIME_DSL_VERSION` and a dedicated
`RUNTIME_DSL_MIGRATIONS` ladder, walked by `migrateRuntime` (not `migrate`), with
`runtimeDslVersionOf` / `needsRuntimeMigration` as the runtime-line counterparts
of `dslVersionOf` / `needsMigration`.

Unlike the document line, the runtime line has **no unversioned epoch**. Real
pre-versioning documents exist, so `migrate` lifts an unstamped document from
`UNVERSIONED_DSL_VERSION` via its first ladder entry. Nothing legitimately
predates the runtime envelope, though — it is a brand-new contract, and the
future `RuntimeStore` stamps `RUNTIME_DSL_VERSION` at write time. So a
`RuntimeSession` is **born stamped** (`runtimeDslVersion` is a **required** field,
not optional), `RUNTIME_DSL_MIGRATIONS` ships **empty** (no legacy-lift entry;
the first real runtime shape change appends a step from the pinned
`INITIAL_RUNTIME_DSL_VERSION` and bumps `RUNTIME_DSL_VERSION`), and an unstamped
object reaching any runtime-line function (`migrateRuntime`,
`needsRuntimeMigration`, `runtimeDslVersionOf`) **throws** — it is a misrouted
legacy document or an unstamped producer write, not legacy data to lift.
(Non-objects stay exempt: they are not migratable aggregates and read as
unversioned on every line.) An empty ladder is still fully functional — a
stamped-current session early-returns as already current, and a session stamped
at an unknown older version hits the "no migration path" fail-loud.

The two lines stamp **different fields**, so neither ladder reads the other's
version — but disjoint fields alone are not enough: a session lacking
`dslVersion` would still read as *unversioned* to the document runner and be
lifted onto the wrong line. The **cross-line guard** —
enforced in the shared envelope reader, so the plain `dslVersionOf` /
`runtimeDslVersionOf` reads, the `needs*Migration` predicates, and the runners
all give one answer per envelope — closes this with three-case semantics: (1) own line's stamp present → migrate normally
on the own line, regardless of the other key; (2) both stamps absent → genuine
legacy data, walk the own ladder; (3) own stamp absent but the sibling line's
stamp present → **throw**. Case (3) is undecidable from the envelope — the
other line's aggregate misrouted here is byte-identical to this line's data
carrying a stray foreign stamp; migrating would mangle the former, returning it
unchanged would permanently orphan the latter from its own line — so it is
treated like a malformed stamp and fails loud. `validateRuntimeSession`
likewise rejects a session **missing** its `runtimeDslVersion` (born stamped, no
legacy epoch) and a **stray** `dslVersion` on a session at the door. The runner
mechanism (contiguous ladder, idempotent, forward-compatible, fail-loud) is
shared; only the ladder, target version, own stamp field, and the sibling field
the guard checks differ.

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
- [x] Own element defaulting in the contract: `normalize.ts` ships the pure
      `normalize*` family + `ELEMENT_DEFAULTS`, and the static defaults ride out
      on the JSON Schema as `@default` annotations. Producers drop their
      imperative "fix up the output" passes. See **Runtime layer** above.
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
