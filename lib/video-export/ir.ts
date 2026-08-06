/**
 * `VideoTimeline` IR — the system contract for classroom-video export.
 *
 * Issue #864 (first architecture slice of #854) makes this IR, not the
 * Hyperframes composition, the contract: the compiler turns classroom data into
 * a `VideoTimeline` with **pure** passes (no FFmpeg / Chrome / DOM), and a thin
 * downstream emitter renders it. Keeping the IR the contract buys testability,
 * subtitle derivation, and human-diffable review, and lets the emitter absorb
 * Hyperframes' pre-1.0 API churn without touching the compiler.
 *
 * Two deliberate modeling choices carried from the issue:
 *
 * - **Effects reference an animation descriptor id** (`spotlight.v1`) rather than
 *   inlining animation params — *what/where happened* lives here in the IR;
 *   *what it looks like* lives in the shared spec (`lib/choreography` descriptors,
 *   #863). The exporter resolves the id against `DESCRIPTORS` at render time.
 * - **Diagnostics are first-class** — estimated durations, skipped media,
 *   unresolved elements and unsupported scenes are all recorded, so the manifest
 *   doubles as an export report and nothing is ever silently dropped.
 *
 * The schema is authored with zod and the TS types are inferred from it (single
 * source), mirroring the descriptor model in `lib/choreography/descriptors`. A
 * consumer (or the `emit` pass' own self-check) can validate any emitted JSON
 * against {@link VideoTimelineSchema}.
 *
 * Pure: depends only on `@openmaic/dsl` (the `SceneType` set) and `zod`.
 */
import { z } from 'zod';
import { SCENE_TYPES } from '@openmaic/dsl';

/** Manifest `schema` tag — stable across versions; the shape is versioned by {@link VIDEO_TIMELINE_VERSION}. */
export const VIDEO_TIMELINE_SCHEMA = 'openmaic.videoTimeline';

/** IR/manifest version. Bump on any breaking shape change. */
export const VIDEO_TIMELINE_VERSION = 3;

/** Compiler identity stamped into the manifest for provenance. */
export const VIDEO_TIMELINE_COMPILER = 'openmaic-video-timeline';

// ---------------------------------------------------------------------------
// Leaf value schemas
// ---------------------------------------------------------------------------

/**
 * Percentage geometry (0–100 space), the coordinate system the animation
 * descriptors and the runtime spotlight/laser overlays use. Mirrors the
 * `PercentageGeometry` shape produced by the pure geometry helper.
 */
export const PercentageGeometrySchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  centerX: z.number(),
  centerY: z.number(),
});

/** Severity of a compile {@link Diagnostic}. */
export const DiagnosticSeveritySchema = z.enum(['info', 'warn', 'error']);

/**
 * Stable diagnostic codes. Every non-fatal degradation the compiler makes gets
 * one, so the manifest is an auditable export report:
 * - `estimated-duration` — a speech dwell was estimated (no stored audio duration).
 * - `missing-audio` — a speech has text but no resolvable audio asset.
 * - `unresolved-element` — an effect's `elementId` had no geometry (degraded).
 * - `skipped-media` — a referenced media/audio asset is absent from the source.
 * - `unsupported-scene` — a remaining runtime-only scene family is not rendered,
 *   represented by markers instead.
 * - `cover-card` — a Quiz/PBL scene is rendered as a deterministic static cover.
 * - `unknown-action` — an action with an unrecognized `type` was dropped.
 * - `invalid-action` — an action missing a required field was dropped.
 * - `interactive-static-html` — an interactive scene uses packaged frozen HTML.
 * - `missing-interactive-html` — an interactive scene has no embedded HTML.
 * - `interactive-html-packaging` — HTML preparation failed or exceeded its bound.
 * - `unresolved-interactive-resource` — an external/relative resource remained.
 */
export const DiagnosticCodeSchema = z.enum([
  'estimated-duration',
  'missing-audio',
  'unresolved-element',
  'skipped-media',
  'unsupported-scene',
  'cover-card',
  'unknown-action',
  'invalid-action',
  'interactive-static-html',
  'missing-interactive-html',
  'interactive-html-packaging',
  'unresolved-interactive-resource',
]);

/** A recorded compile-time degradation or note. Never thrown away — first-class in the IR. */
export const DiagnosticSchema = z.object({
  severity: DiagnosticSeveritySchema,
  code: DiagnosticCodeSchema,
  sceneId: z.string().optional(),
  actionId: z.string().optional(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Segment schemas (per-scene buckets)
// ---------------------------------------------------------------------------

/** Where a segment's audio duration came from. */
export const DurationSourceSchema = z.enum(['stored', 'estimated']);

/** The scene's visual base layer. */
export const BaseSegmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('slide-snapshot'),
    /** Asset-plan path for the base frame image, when one is planned. */
    assetRef: z.string().optional(),
  }),
  z.object({ kind: z.literal('visual-segments') }),
  z.object({
    kind: z.literal('placeholder'),
    /** Why a placeholder was used (unsupported scene family or failed HTML capture). */
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal('interactive-html'),
    /** Stable prepared-content identity; the asset pass maps it to assetRef. */
    assetId: z.string(),
    /** Asset-plan path for the packaged HTML page. */
    assetRef: z.string().optional(),
    /** SHA-256 of the exact packaged HTML bytes. */
    contentHash: z.string(),
    /** Bounded load/readiness deadline used by the emitted parent bridge. */
    readyTimeoutMs: z.number().int().positive(),
    /** Quiet period before the child page is frozen. */
    settleMs: z.number().int().nonnegative(),
  }),
]);

const TimedVisualSegmentSchema = z.object({
  startMs: z.number(),
  durationMs: z.number(),
});

/** Static Quiz title card. Questions/answers stay out of the cover IR by design. */
export const QuizCoverVisualSchema = TimedVisualSegmentSchema.extend({
  kind: z.literal('quiz-cover'),
  title: z.string(),
  questionCount: z.number(),
  totalPoints: z.number(),
});

/** Static PBL Hero-style card built only from authored, learner-visible design fields. */
export const PblCoverVisualSchema = TimedVisualSegmentSchema.extend({
  kind: z.literal('pbl-cover'),
  title: z.string(),
  description: z.string(),
  gains: z.array(z.string()),
  stageCount: z.number(),
  taskCount: z.number(),
  instructorName: z.string().optional(),
  instructorDescription: z.string().optional(),
  scenarioCharacterName: z.string().optional(),
});

/**
 * Timed visual layers are a discriminated union so later slices can add visual
 * states (for example #986's Quiz question list) without changing scene timing.
 */
export const VisualSegmentSchema = z.discriminatedUnion('kind', [
  QuizCoverVisualSchema,
  PblCoverVisualSchema,
]);

/** Narration (speech) segment — one authored `speech` action laid on the wall-clock. */
export const NarrationSegmentSchema = z.object({
  actionId: z.string().optional(),
  actionIndex: z.number(),
  startMs: z.number(),
  durationMs: z.number(),
  text: z.string(),
  audio: z.object({
    assetId: z.string().optional(),
    /** Asset-plan path, present only when the clip is bundled. */
    assetRef: z.string().optional(),
    durationMs: z.number(),
    source: DurationSourceSchema,
    present: z.boolean(),
  }),
});

/**
 * Effect segment (spotlight/laser). References a versioned animation descriptor
 * id — the animation *values* live in `lib/choreography/descriptors`, not here.
 * `geometry` is the resolved target geometry (null when the element could not be
 * located, in which case `degraded` is true and an `unresolved-element`
 * diagnostic was emitted).
 *
 * `params` carries the **effective** per-instance parameters: the descriptor's
 * defaults with the authored action overrides merged in (spotlight `dimOpacity`,
 * laser `color`). An IR-only emitter reads these directly — descriptor defaults
 * alone cannot recover an authored override.
 */
export const EffectSegmentSchema = z.object({
  actionId: z.string().optional(),
  actionIndex: z.number(),
  type: z.enum(['spotlight', 'laser']),
  /** Versioned descriptor id, e.g. `spotlight.v1`, resolved against `DESCRIPTORS`. */
  descriptorId: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  elementId: z.string(),
  geometry: PercentageGeometrySchema.nullable(),
  /** Effective params: descriptor defaults merged with authored overrides. */
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  degraded: z.boolean(),
});

/**
 * Video-playback segment (`play_video`). Carries the target element's placement
 * (`geometry` in 0–100 space + `rotate` in degrees) so an IR-only emitter can
 * position the real clip without re-reading the scene DSL, and the resolved
 * media identity (`assetId` / `assetRef` / `present`) so a referenced-but-missing
 * clip is represented structurally, not only in a diagnostic.
 *
 * `durationSource`:
 * - `stored` — a real clip duration within the safety cap.
 * - `capped` — a resolved duration clamped to `MAX_VIDEO_WAIT_MS`, or an
 *   available clip whose duration was unknown (assumed the cap).
 * - `zero` — an unresolved duration under the explicit `'zero'` policy.
 * - `skipped` — the media is unavailable (no association or bytes missing); the
 *   segment occupies **0ms** so later actions are not shifted (skip + diagnostic).
 */
export const VideoSegmentSchema = z.object({
  actionId: z.string().optional(),
  actionIndex: z.number(),
  startMs: z.number(),
  durationMs: z.number(),
  elementId: z.string(),
  geometry: PercentageGeometrySchema.nullable(),
  /** Element rotation in degrees; 0 when unresolved. */
  rotate: z.number(),
  assetId: z.string().optional(),
  assetRef: z.string().optional(),
  present: z.boolean(),
  /** True when the target element's geometry could not be resolved. */
  degraded: z.boolean(),
  durationSource: z.enum(['stored', 'capped', 'zero', 'skipped']),
});

/**
 * A marker — any beat that is not base/narration/effect/video: whiteboard and
 * widget actions, discussions, the synthetic implicit-whiteboard-open and
 * empty-scene dwells, and whole unsupported scenes. Markers keep every beat on
 * the timeline so nothing is silently dropped (issue AC), even before the
 * exporter can render it.
 */
export const MarkerSchema = z.object({
  actionId: z.string().optional(),
  actionIndex: z.number(),
  /** The action `type`, or a synthetic kind (`unsupported-scene` / `implicit-wb-open` / `empty-scene`). */
  kind: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Scene + top-level schemas
// ---------------------------------------------------------------------------

export const VideoTimelineSceneSchema = z.object({
  id: z.string(),
  index: z.number(),
  title: z.string(),
  type: z.enum(SCENE_TYPES),
  startMs: z.number(),
  durationMs: z.number(),
  /** False for scene families the compiler cannot render or that failed preparation. */
  supported: z.boolean(),
  base: BaseSegmentSchema,
  visuals: z.array(VisualSegmentSchema),
  narration: z.array(NarrationSegmentSchema),
  effects: z.array(EffectSegmentSchema),
  videos: z.array(VideoSegmentSchema),
  markers: z.array(MarkerSchema),
});

/** One subtitle cue — one per non-empty `speech` action. */
export const SubtitleCueSchema = z.object({
  index: z.number(),
  sceneId: z.string(),
  actionId: z.string().optional(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
});

/** The kind of asset a plan entry bundles. */
export const AssetKindSchema = z.enum(['audio', 'image', 'video', 'poster', 'frame', 'html']);

/**
 * A single planned asset in the export zip. The plan is layout + naming only —
 * the actual bytes are collected by the browser-side implementation in the next
 * phase (P1d). `dedupOf` points a later reference at the first entry that owns
 * the shared asset id.
 */
export const AssetPlanEntrySchema = z.object({
  assetId: z.string(),
  kind: AssetKindSchema,
  /** Path within the export zip, e.g. `audio/001-intro/speech-001.mp3`. */
  path: z.string(),
  /** Whether the source has the bytes; false → `skipped-media` diagnostic. */
  present: z.boolean(),
  /** Set on a duplicate reference: the `assetId` of the first entry that owns it. */
  dedupOf: z.string().optional(),
});

export const AssetPlanSchema = z.object({
  entries: z.array(AssetPlanEntrySchema),
});

export const CanvasSchema = z.object({
  /** 0–100 percentage space (matches descriptors + geometry). */
  viewBox: z.object({ width: z.number(), height: z.number() }),
  /** Pixel base the runtime uses to compute percentages (1000 × 562.5, 16:9). */
  pixelBase: z.object({ width: z.number(), height: z.number() }),
  aspectRatio: z.string(),
});

/** The determinism inputs the timeline was resolved under. */
export const TimelineConfigSchema = z.object({
  playbackSpeed: z.number(),
  /** Whether any narration had stored TTS audio (vs. all durations estimated). */
  ttsEnabled: z.boolean(),
  whiteboardInitiallyOpen: z.boolean(),
});

/** The full IR / manifest. */
export const VideoTimelineSchema = z.object({
  schema: z.literal(VIDEO_TIMELINE_SCHEMA),
  version: z.literal(VIDEO_TIMELINE_VERSION),
  compiler: z.string(),
  stage: z.object({ id: z.string(), name: z.string() }),
  canvas: CanvasSchema,
  config: TimelineConfigSchema,
  totalDurationMs: z.number(),
  scenes: z.array(VideoTimelineSceneSchema),
  subtitles: z.array(SubtitleCueSchema),
  assets: AssetPlanSchema,
  diagnostics: z.array(DiagnosticSchema),
});

// ---------------------------------------------------------------------------
// Inferred types (schema is the single source)
// ---------------------------------------------------------------------------

export type PercentageGeometry = z.infer<typeof PercentageGeometrySchema>;
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;
export type DiagnosticCode = z.infer<typeof DiagnosticCodeSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type DurationSource = z.infer<typeof DurationSourceSchema>;
export type BaseSegment = z.infer<typeof BaseSegmentSchema>;
export type QuizCoverVisual = z.infer<typeof QuizCoverVisualSchema>;
export type PblCoverVisual = z.infer<typeof PblCoverVisualSchema>;
export type VisualSegment = z.infer<typeof VisualSegmentSchema>;
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;
export type EffectSegment = z.infer<typeof EffectSegmentSchema>;
export type VideoSegment = z.infer<typeof VideoSegmentSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type VideoTimelineScene = z.infer<typeof VideoTimelineSceneSchema>;
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;
export type AssetKind = z.infer<typeof AssetKindSchema>;
export type AssetPlanEntry = z.infer<typeof AssetPlanEntrySchema>;
export type AssetPlan = z.infer<typeof AssetPlanSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type TimelineConfig = z.infer<typeof TimelineConfigSchema>;
export type VideoTimeline = z.infer<typeof VideoTimelineSchema>;

/** The canvas constants the runtime renders at (16:9, 1000px base). */
export const CANVAS: Canvas = {
  viewBox: { width: 100, height: 100 },
  pixelBase: { width: 1000, height: 562.5 },
  aspectRatio: '16:9',
};

/** Thrown for structural failures the compiler cannot degrade past (e.g. no scenes). */
export class VideoTimelineCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoTimelineCompileError';
  }
}
