/**
 * Dependency-injection boundary for the video-timeline compiler.
 *
 * The compiler is pure (issue #864 / #854 AC: the IR must be produced and
 * inspected without FFmpeg / Chrome / DOM). Everything it needs from live app
 * state — audio/video durations, which assets actually exist — enters through
 * these **synchronous** interfaces. The app provides Dexie/DOM-backed
 * implementations that pre-resolve the data (durations are stored at TTS time,
 * #861); tests provide plain in-memory stubs. Neither reaches into the compiler.
 *
 * Sync by design: with durations pre-resolved (#861) the whole compile is a pure
 * synchronous fold, which is what makes it trivially unit-testable — a stub is a
 * literal object, not a Promise-returning mock.
 *
 * Pure: types only, from `@openmaic/dsl`.
 */
import type {
  SpeechAction,
  PlayVideoAction,
  WbClearAction,
  WbEditCodeAction,
  DiscussionAction,
  SceneCore,
  SceneType,
  PPTElement,
} from '@openmaic/dsl';

/**
 * The compiler's scene input — the structural slice it reads. Deliberately
 * looser than the app's fully-instantiated `Scene`: it needs `SceneCore`
 * (id/title/order/actions), the `type` discriminant, and — for slide scenes —
 * the canvas elements the geometry pass resolves against. An app `Scene`
 * (slide/quiz/interactive/pbl) is structurally assignable to this, so callers
 * pass their scenes without casting; non-slide content simply lacks `canvas`.
 */
export type CompilerScene = SceneCore & {
  type: SceneType;
  content?: { type?: string; canvas?: { elements?: PPTElement[] } };
};

/**
 * Timing source — the durations the pure {@link resolveActionTimeline} cannot
 * derive on its own. Each method mirrors a `ResolveTimelineOptions` callback; the
 * `probe` pass adapts this interface into that option shape. All synchronous:
 * the app resolves stored durations up front (#861) and hands over a table.
 */
export interface TimingProbe {
  /**
   * Natural (1×) narration duration in ms for a speech action with stored audio,
   * or `null` to fall back to the deterministic no-audio estimate. The timeline
   * divides a returned value by `playbackSpeed`, matching the live audio path.
   */
  audioDurationMs(action: SpeechAction): number | null;
  /**
   * Video duration in ms for a `play_video` action, or `null` when unknown (the
   * `onUnresolvedVideoDuration` policy then decides). Capped at the shared
   * `MAX_VIDEO_WAIT_MS`.
   */
  videoDurationMs(action: PlayVideoAction): number | null;
  /** Live whiteboard element count when a `wb_clear` runs (the clear anim scales with it). Default 0. */
  clearElementCount?(action: WbClearAction): number;
  /** Whether a discussion is skipped by the engine (consumed / agent not selected) → no dwell. */
  isDiscussionSkipped?(action: DiscussionAction): boolean;
  /** Whether a `wb_edit_code` is a no-op the engine skips without delay. */
  isEditCodeNoop?(action: WbEditCodeAction): boolean;
}

/** Metadata about one bundleable asset — enough to plan layout/naming, not the bytes. */
export interface AssetMeta {
  /** Stable id used for dedup (e.g. the stored audio/media record id). */
  id: string;
  mimeType?: string;
  /** File extension hint (e.g. `mp3`, `png`, `mp4`); the planner falls back from `mimeType`. */
  format?: string;
  durationMs?: number;
  /** Whether the source actually has the bytes. False → `skipped-media` diagnostic. */
  present: boolean;
}

/**
 * Asset source — resolves which narration/media assets exist and their metadata,
 * so the `assets` pass can build a dedup + naming plan. Returns descriptors only;
 * the browser-side collector fetches the blobs in the next phase (P1d). `null`
 * means "no asset referenced" (distinct from an asset that is referenced but
 * `present: false`).
 */
export interface AssetSource {
  /** Audio asset backing a speech action, or null when it has none. */
  audio(action: SpeechAction): AssetMeta | null;
  /** Media asset (image/video) for an element on a scene, or null when none. */
  media(elementId: string, scene: SceneCore): AssetMeta | null;
}

/** Compiler configuration — the determinism inputs recorded into the IR's `config`. */
export interface CompileConfig {
  /** Playback speed multiplier applied to speech dwell. Default 1. */
  playbackSpeed?: number;
  /** Whether the whiteboard is already open when the timeline starts. Default false. */
  whiteboardInitiallyOpen?: boolean;
  /**
   * Policy when a `play_video` duration is unresolved. Default `'cap'` (assume the
   * safety cap) — unlike the choreography default of `'throw'`, the exporter
   * prefers to degrade with a diagnostic over failing the whole compile.
   */
  onUnresolvedVideoDuration?: 'throw' | 'cap' | 'zero';
}
