/**
 * `timeline` pass — fold the choreography timeline into per-scene IR buckets.
 *
 * Calls the shared {@link resolveActionTimeline} (the single source of truth for
 * index→time expansion, blocking vs fire-and-forget, whiteboard auto-open, and
 * effect-lifetime clamping) and sorts the resulting flat segment list into each
 * scene's `base / narration / effects / videos / markers`. It also derives the
 * subtitle track (one cue per non-empty speech) and the total duration, and
 * records `estimated-duration` diagnostics where narration had no stored audio.
 *
 * Effect segments are emitted with `geometry: null` here; the `geometry` pass
 * fills them. Narration/video asset identity (`assetId` / `assetRef` / `present`)
 * is left for the `assets` pass. This pass owns *timing* only.
 *
 * Pure: no IO; timing comes entirely through the injected options.
 */
import type {
  Action,
  SpeechAction,
  PlayVideoAction,
  SpotlightAction,
  LaserAction,
} from '@openmaic/dsl';
import {
  resolveActionTimeline,
  getDescriptor,
  EMPTY_SCENE_DWELL,
  IMPLICIT_WB_OPEN,
  MAX_VIDEO_WAIT_MS,
  type ResolveTimelineOptions,
  type TimelineSegment,
} from '../../choreography';
import type { CompilerScene } from '../deps';
import type {
  Diagnostic,
  EffectSegment,
  Marker,
  NarrationSegment,
  SubtitleCue,
  VideoSegment,
  VideoTimelineScene,
} from '../ir';

export interface TimelineResult {
  scenes: VideoTimelineScene[];
  subtitles: SubtitleCue[];
  totalDurationMs: number;
  /** Whether any narration had stored TTS audio (vs. all durations estimated). */
  ttsEnabled: boolean;
  diagnostics: Diagnostic[];
}

/** Descriptor id an effect action references — the animation values live in `lib/choreography/descriptors`. */
const DESCRIPTOR_ID: Record<'spotlight' | 'laser', string> = {
  spotlight: 'spotlight.v1',
  laser: 'laser.v1',
};

/**
 * Effective per-instance effect params: the descriptor's declared defaults
 * merged with the authored action overrides playback honors (spotlight
 * `dimOpacity` → `dimness`, laser `color`). An IR-only emitter reads these
 * directly; descriptor defaults alone cannot recover an authored override.
 */
function effectParams(action: SpotlightAction | LaserAction): Record<string, number | string> {
  const descriptor = getDescriptor(DESCRIPTOR_ID[action.type]);
  const params: Record<string, number | string> = { ...(descriptor?.params ?? {}) };
  if (action.type === 'spotlight') {
    if (action.dimOpacity != null) params.dimness = action.dimOpacity;
  } else if (action.color != null) {
    params.color = action.color;
  }
  return params;
}

/** Per-scene mutable accumulator, sealed into a {@link VideoTimelineScene} at the end. */
interface SceneBuckets {
  narration: NarrationSegment[];
  effects: EffectSegment[];
  videos: VideoSegment[];
  markers: Marker[];
}

function emptyBuckets(): SceneBuckets {
  return { narration: [], effects: [], videos: [], markers: [] };
}

export function buildTimeline(
  scenes: readonly CompilerScene[],
  opts: ResolveTimelineOptions,
): TimelineResult {
  const segments = resolveActionTimeline(scenes as CompilerScene[], opts);

  // Cursor completion clock: fire-and-forget effects advance the cursor by 0, so
  // they never extend it — this is the total playback duration.
  const totalDurationMs = segments.reduce(
    (max, seg) => Math.max(max, seg.startMs + seg.advancesCursorMs),
    0,
  );

  // First segment startMs per scene index → the scene's wall-clock start. Every
  // scene yields ≥1 segment (empty scenes get a dwell beat), so all indices exist.
  const sceneStartMs = new Map<number, number>();
  for (const seg of segments) {
    if (!sceneStartMs.has(seg.sceneIndex)) sceneStartMs.set(seg.sceneIndex, seg.startMs);
  }

  const buckets = scenes.map(() => emptyBuckets());
  const diagnostics: Diagnostic[] = [];
  const subtitles: SubtitleCue[] = [];
  let ttsEnabled = false;

  for (const seg of segments) {
    const bucket = buckets[seg.sceneIndex];
    if (!bucket) continue; // defensive: index always valid
    dispatchSegment(seg, bucket, opts, diagnostics, subtitles, () => {
      ttsEnabled = true;
    });
  }

  const irScenes: VideoTimelineScene[] = scenes.map((scene, index) => {
    const start = sceneStartMs.get(index) ?? 0;
    const end = sceneStartMs.get(index + 1) ?? totalDurationMs;
    const supported = scene.type === 'slide';
    return {
      id: scene.id,
      index,
      title: scene.title,
      type: scene.type,
      startMs: start,
      durationMs: Math.max(0, end - start),
      supported,
      base: { kind: supported ? 'slide-snapshot' : 'placeholder' },
      ...buckets[index],
    };
  });

  return { scenes: irScenes, subtitles, totalDurationMs, ttsEnabled, diagnostics };
}

function dispatchSegment(
  seg: TimelineSegment,
  bucket: SceneBuckets,
  opts: ResolveTimelineOptions,
  diagnostics: Diagnostic[],
  subtitles: SubtitleCue[],
  markTts: () => void,
): void {
  const action = seg.action;
  const base = { actionId: action.id, actionIndex: seg.actionIndex } as const;

  // Synthetic beats resolveActionTimeline injects — kept as markers so they show
  // on the timeline but are distinguishable from authored actions.
  if (action.id === EMPTY_SCENE_DWELL.id) {
    bucket.markers.push({
      ...base,
      kind: 'empty-scene',
      startMs: seg.startMs,
      durationMs: seg.durationMs,
      note: 'Scene has no actions; synthetic dwell beat.',
    });
    return;
  }
  if (action.id === IMPLICIT_WB_OPEN.id) {
    bucket.markers.push({
      ...base,
      kind: 'implicit-wb-open',
      startMs: seg.startMs,
      durationMs: seg.durationMs,
      note: 'Implicit whiteboard open before a mutation on a closed board.',
    });
    return;
  }

  switch (action.type) {
    case 'speech': {
      const speech = action as SpeechAction;
      const stored = opts.getAudioDurationMs?.(speech) != null;
      if (stored) markTts();
      bucket.narration.push({
        ...base,
        startMs: seg.startMs,
        durationMs: seg.durationMs,
        text: speech.text,
        audio: {
          durationMs: seg.durationMs,
          source: stored ? 'stored' : 'estimated',
          present: false, // filled by the assets pass
        },
      });
      if (!stored && speech.text.trim()) {
        diagnostics.push({
          severity: 'info',
          code: 'estimated-duration',
          actionId: speech.id,
          message: `Narration duration estimated (no stored audio) for "${preview(speech.text)}".`,
        });
      }
      if (speech.text.trim()) {
        subtitles.push({
          index: subtitles.length,
          sceneId: seg.sceneId,
          actionId: speech.id,
          startMs: seg.startMs,
          endMs: seg.startMs + seg.durationMs,
          text: speech.text,
        });
      }
      return;
    }
    case 'spotlight':
    case 'laser':
      bucket.effects.push({
        ...base,
        type: action.type,
        descriptorId: DESCRIPTOR_ID[action.type],
        startMs: seg.startMs,
        durationMs: seg.durationMs,
        elementId: (action as SpotlightAction | LaserAction).elementId,
        geometry: null, // filled by the geometry pass
        params: effectParams(action as SpotlightAction | LaserAction),
        degraded: false,
      });
      return;
    case 'play_video': {
      const resolved = opts.getVideoDurationMs?.(action as PlayVideoAction);
      // A resolved value above the safety cap is clamped by resolveActionTimeline,
      // so `durationMs` is the cap, not the clip's true length — label it 'capped'
      // (not 'stored') so a consumer doesn't read the cap as the real duration.
      const durationSource: VideoSegment['durationSource'] =
        resolved != null
          ? resolved > MAX_VIDEO_WAIT_MS
            ? 'capped'
            : 'stored'
          : opts.onUnresolvedVideoDuration === 'zero'
            ? 'zero'
            : 'capped';
      bucket.videos.push({
        ...base,
        startMs: seg.startMs,
        durationMs: seg.durationMs,
        elementId: (action as PlayVideoAction).elementId,
        geometry: null, // filled by the geometry pass
        rotate: 0, // filled by the geometry pass
        present: false, // filled by the assets pass
        degraded: false, // set by the geometry pass
        durationSource,
      });
      return;
    }
    default:
      // Whiteboard / widget / discussion beats — carried as markers until the
      // exporter can render them, so nothing is silently dropped.
      bucket.markers.push({
        ...base,
        kind: (action as Action).type,
        startMs: seg.startMs,
        durationMs: seg.durationMs,
      });
  }
}

/** Short single-line preview of narration text for diagnostics. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
