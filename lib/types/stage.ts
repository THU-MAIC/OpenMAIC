// Stage and Scene data types.
//
// The universal lesson skeleton (Stage / Scene / SceneContent / Whiteboard /
// VideoManifest / SlideContent / QuizContent / …) now lives in `@openmaic/dsl` and
// is re-exported below. `Scene` is generic there: the contract owns only the
// structure + the slide/quiz content kinds, while the playback `Action` set and
// the richer feature content (interactive widgets, PBL) are app-side and get
// composed in here.
//
// `Scene` is re-exported as an alias of the app's fully-instantiated
// `Scene<Action, AppSceneContent>`, so existing `import { Scene }` callers keep
// the same semantics (actions are `Action[]`, content spans all four kinds).
import type { Scene as DslScene, SceneContent as DslSceneContent } from '@openmaic/dsl';
import type { Action } from '@/lib/types/action';
import type { WidgetType, WidgetConfig } from '@/lib/types/widgets';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export type {
  SceneType,
  StageMode,
  Whiteboard,
  VideoManifestEntry,
  VideoManifest,
  GeneratedAgentConfig,
  MultiAgentConfig,
  Stage,
  SlideContent,
  QuizOption,
  QuizQuestion,
  QuizContent,
} from '@openmaic/dsl';

// The two discriminant guards are runtime functions, so they must be value
// re-exported — a bare `export type {}` erases them and leaves the import as
// `undefined` at runtime / "cannot be used as a value" at the type level.
export { isSlideContent, isQuizContent } from '@openmaic/dsl';

// `@openmaic/dsl` inlines the question-type union on `QuizQuestion.type` rather than
// exporting a named alias; derive it here so editor quiz code can keep importing
// `QuizQuestionType` from `@/lib/types/stage`.
export type QuizQuestionType = import('@openmaic/dsl').QuizQuestion['type'];

// The contract's `SceneContent` is the universal subset (slide | quiz). Reach it
// under a distinct name; the app's own `SceneContent` (declared below) is the
// full four-way union so existing `switch (content.type)` call sites keep all
// four cases.
export type { SceneContent as SceneContentBase } from '@openmaic/dsl';

// The raw, generic contract Scene is reachable under a distinct name for
// callers (e.g. read-only renderers) that want the feature-free skeleton.
export type { Scene as SceneShape } from '@openmaic/dsl';

/**
 * Interactive content - Interactive web page (iframe).
 *
 * App-level feature surface: kept here rather than in `@openmaic/dsl` because it
 * couples to Ultra-mode widget configs (`WidgetType` / `WidgetConfig`).
 */
export interface InteractiveContent {
  type: 'interactive';
  url: string; // URL of the interactive page
  // Optional: embedded HTML content
  html?: string;
  // Ultra Mode widget fields
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
}

/**
 * PBL content - Project-based learning.
 *
 * App-level feature surface: kept here rather than in `@openmaic/dsl` because it
 * couples to the project-based-learning config (`PBLProjectConfig`).
 */
export interface PBLContent {
  type: 'pbl';
  projectConfig: PBLProjectConfig;
  /** PBL v2 payload used by the new web-PBL runtime, while preserving v1 compatibility. */
  projectV2?: PBLProjectV2;
}

/**
 * The app's full scene-content union: the contract's universal kinds plus the
 * app-only feature kinds. This is what `@/lib/types/stage` callers have always
 * known as `SceneContent` (all four cases).
 */
export type AppSceneContent = DslSceneContent | InteractiveContent | PBLContent;

/**
 * The app's `SceneContent` — the full four-way union. Overrides the contract's
 * narrower `SceneContentBase` (slide | quiz) so call sites that switch on all
 * four `content.type` cases keep compiling.
 */
export type SceneContent = AppSceneContent;

/**
 * The app's concrete scene type: the contract skeleton instantiated with the
 * app's playback action set and full content union.
 *
 * Aliased as `Scene` so existing `import { Scene } from '@/lib/types/stage'`
 * callers keep their original semantics (actions are `Action[]`, content spans
 * all four kinds).
 */
export type AppScene = DslScene<Action, SceneContent> & {
  /**
   * Stable id of the generation outline this scene was built from. Lets editor
   * agent tools resolve a scene's outline by identity instead of by the mutable
   * `order`, which Pro-mode insert / reorder / delete rebalances (matching by
   * `order` after a reorder attaches another slide's outline). An app-layer
   * annotation only — not part of the `@openmaic/dsl` Scene contract. Absent on
   * inserted scenes and pre-existing data, where callers fall back to a
   * scene-derived outline.
   */
  outlineId?: string;
};
export type Scene = AppScene;

/**
 * A partial update for {@link AppScene} — the patch shape used by `updateScene` /
 * `applyScenePatchInSync` / the regenerate-apply plan.
 *
 * `Partial<AppScene>` is unusable here: `AppScene` is a discriminated union, and
 * `Partial<>` *distributes* over it into a union of per-kind partials
 * (`Partial<SlideScene> | Partial<QuizScene> | …`). A generic patch such as
 * `{ content }`, where `content: SceneContent` spans all four kinds, then matches
 * none of those members. `ScenePatch` is a single (non-distributive) object type
 * that keeps `type` and `content` as independently-optional wide unions, which is
 * exactly what a shallow-merge patch needs.
 */
export type ScenePatch = Partial<Omit<AppScene, 'type' | 'content'>> & {
  type?: SceneContent['type'];
  content?: SceneContent;
};

/**
 * Build an {@link AppScene} from its kind-independent {@link SceneCore} plus a
 * concrete content payload, binding `type` to `content.type`.
 *
 * The lone `as` is unavoidable and is the *only* cast in the scene-construction
 * path: `AppScene` is a distributive discriminated union, and TS cannot prove
 * that the freshly-built `{ ...core, type, content }` literal lands in the member
 * matching `content`'s kind when that kind is only known through a generic. The
 * generic return type re-narrows the result to the single member whose `type`
 * equals `content.type`, so every call site still sees a correctly discriminated
 * scene. `type` is always derived from `content.type`, which makes the binding
 * impossible to violate at a call site.
 */
export function makeScene<C extends SceneContent>(
  core: Omit<AppScene, 'type' | 'content'>,
  content: C,
): Extract<AppScene, { type: C['type'] }> {
  return { ...core, type: content.type, content } as Extract<AppScene, { type: C['type'] }>;
}
