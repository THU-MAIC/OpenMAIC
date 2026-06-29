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
export type AppScene = DslScene<Action, SceneContent>;
export type Scene = AppScene;
