/**
 * Stage / Scene / SceneContent — the universal lesson-skeleton contract.
 *
 * This module owns the *structural* part of a lesson: the top-level `Stage`
 * container and a per-page `Scene` whose `content` is a discriminated union of
 * the universal content kinds (`SlideContent`, `QuizContent`). Richer,
 * faster-moving feature surfaces (playback `Action`s, Ultra-mode widgets, PBL
 * project configs) are deliberately *not* defined here — they stay in the
 * consuming app and are threaded in through `Scene`'s generic parameters.
 *
 * The split keeps `@openmaic/dsl` focused on the lesson skeleton while letting the
 * runtime engine, renderer, and importer share one source of truth for it.
 *
 * No runtime dependencies. Pure types + pure discriminant guards only.
 */
import type { Slide } from './slides.js';

/** All scene kinds the contract is aware of. Feature kinds (interactive/pbl) are still valid `type` values — their *content* shapes live in the app and are composed in via {@link Scene}'s `TContent` parameter. */
export type SceneType = 'slide' | 'quiz' | 'interactive' | 'pbl';

/** Lifecycle / interaction mode a {@link Stage} can be operated in. */
export type StageMode = 'autonomous' | 'playback' | 'edit';

/**
 * A whiteboard slide. Structurally a {@link Slide} minus the fields that only
 * make sense on a primary canvas (`theme`, `turningMode`, `sectionTag`, `type`).
 */
export type Whiteboard = Omit<Slide, 'theme' | 'turningMode' | 'sectionTag' | 'type'>;

export interface VideoManifestEntry {
  type: 'video';
  prompt: string;
  aspectRatio?: string;
}

export type VideoManifest = Record<string, VideoManifestEntry>;

/**
 * Server-generated agent configuration. Embedded in persisted classroom JSON
 * so clients can hydrate the agent registry without relying on IndexedDB
 * pre-population. Only present for API-generated classrooms.
 */
export interface GeneratedAgentConfig {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
}

/**
 * Multi-agent discussion configuration for a single scene.
 */
export interface MultiAgentConfig {
  /** Enable multi-agent for this scene. */
  enabled: boolean;
  /** Which agents to include (from the registry). */
  agentIds: string[];
  /** Optional custom director instructions. */
  directorPrompt?: string;
}

/**
 * Stage - Represents the entire classroom/course.
 */
export interface Stage {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  // Stage metadata
  languageDirective?: string;
  style?: string;
  // Whiteboard data
  whiteboard?: Whiteboard[];
  // Generated video requests keyed by the mediaRef used by PPTVideoElement.
  // Runtime media state lives in the media task store / persisted media files.
  videoManifest?: VideoManifest;
  // Agent IDs selected when this classroom was created
  agentIds?: string[];
  /**
   * Server-generated agent configurations. See {@link GeneratedAgentConfig}.
   */
  generatedAgentConfigs?: GeneratedAgentConfig[];
  /**
   * True when this classroom was generated with Interactive Mode enabled
   * (the INTERACTIVE_OUTLINES prompt branch).
   * Absent on legacy classrooms, imports, and regular-mode generations.
   */
  interactiveMode?: boolean;
  /**
   * True when this classroom was generated with the vocational Task Engine
   * path enabled. This is distinct from `interactiveMode`: task-engine
   * classrooms are interactive, but not every interactive classroom is
   * vocational.
   */
  taskEngineMode?: boolean;
}

/**
 * Slide content - PPTist Canvas data.
 *
 * `schemaVersion` tags the on-disk shape of this content so future schema
 * changes can ship behind a migration step (see the app's `migrateSlideContent`).
 * Optional for backward compatibility — legacy / pre-versioning data lacks the
 * field and the app normalizes it.
 */
export interface SlideContent {
  type: 'slide';
  schemaVersion?: number;
  // PPTist slide data structure
  canvas: Slide;
}

export interface QuizOption {
  label: string; // Display text
  value: string; // Selection key: "A", "B", "C", "D"
}

export interface QuizQuestion {
  id: string;
  type: 'single' | 'multiple' | 'short_answer';
  question: string;
  options?: QuizOption[];
  answer?: string[]; // Correct answer values: ["A"], ["A","C"], or undefined for text
  analysis?: string; // Explanation shown after grading
  commentPrompt?: string; // Grading guidance for text questions
  hasAnswer?: boolean; // Whether auto-grading is possible
  points?: number; // Points per question (default 1)
}

/**
 * Quiz content - React component props/data.
 */
export interface QuizContent {
  type: 'quiz';
  questions: QuizQuestion[];
}

/**
 * The universal scene-content kinds owned by the contract.
 *
 * App-specific kinds (interactive / pbl) are NOT members here: they carry
 * richer feature coupling (Ultra-mode widgets, PBL project configs) and stay in
 * the consuming app. Apps compose their full content union as
 * `SceneContent | InteractiveContent | PBLContent` and feed it to {@link Scene}'s
 * `TContent` parameter.
 */
export type SceneContent = SlideContent | QuizContent;

/**
 * Scene - Represents a single page/scene in the course.
 *
 * Generic so the contract owns only the universal skeleton while the app
 * injects its concrete playback action set and full content union:
 *
 * ```ts
 * // app side
 * type AppScene = Scene<Action, AppSceneContent>;
 * ```
 *
 * Defaults (`TAction = never`, `TContent = SlideContent | QuizContent`) yield a
 * read-only, feature-free scene — what renderers / importers that only care
 * about the skeleton want. The `TContent` constraint is structural — any union
 * of objects tagged with a `type: SceneType` discriminant satisfies it — so an
 * app can pass its own wider content union (slide | quiz | interactive | pbl).
 *
 * @template TAction  - The playback action type (defaults to `never`, i.e. none).
 * @template TContent - The scene-content union; any object union tagged with a
 *                      `type: {@link SceneType}` discriminant (defaults to the
 *                      two universal kinds).
 */
export interface Scene<
  TAction = never,
  TContent extends { type: SceneType } = SlideContent | QuizContent,
> {
  id: string;
  stageId: string; // ID of the parent stage (for data integrity checks)
  type: SceneType;
  title: string;
  order: number; // Display order

  // Type-specific content
  content: TContent;

  // Actions to execute during playback (app-injected)
  actions?: TAction[];

  // Whiteboards to explain deeply
  whiteboards?: Slide[];

  // Multi-agent discussion configuration
  multiAgent?: MultiAgentConfig;

  // Metadata
  createdAt?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Pure discriminant guards
// ---------------------------------------------------------------------------

/**
 * Narrow a candidate to {@link SlideContent}. Accepts any value tagged with a
 * `type: SceneType` discriminant — including an app-widened content union that
 * adds interactive / pbl kinds beyond the contract's universal two.
 * Pure, no runtime deps.
 */
export function isSlideContent<T extends { type: SceneType }>(
  content: T,
): content is T & SlideContent {
  return content.type === 'slide';
}

/**
 * Narrow a candidate to {@link QuizContent}. Accepts any value tagged with a
 * `type: SceneType` discriminant — including an app-widened content union that
 * adds interactive / pbl kinds beyond the contract's universal two.
 * Pure, no runtime deps.
 */
export function isQuizContent<T extends { type: SceneType }>(
  content: T,
): content is T & QuizContent {
  return content.type === 'quiz';
}
