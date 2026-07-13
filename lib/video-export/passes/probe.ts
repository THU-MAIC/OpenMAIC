/**
 * `probe` pass — adapt the injected {@link TimingProbe} into the option shape
 * {@link resolveActionTimeline} consumes.
 *
 * The choreography timeline is driven by callbacks (`getAudioDurationMs`,
 * `getVideoDurationMs`, …); the compiler exposes those to the app as the
 * cohesive {@link TimingProbe} interface instead. This pass is the thin bridge
 * between the two, and also folds in the {@link CompileConfig} determinism
 * inputs (playback speed, initial whiteboard state, unresolved-video policy).
 *
 * Pure: a straight structural mapping, no IO.
 */
import type { PlayVideoAction } from '@openmaic/dsl';
import type { ResolveTimelineOptions } from '../../choreography';
import type { TimingProbe, CompileConfig } from '../deps';

/**
 * Build the {@link ResolveTimelineOptions} for a compile run from the injected
 * probe and config. Optional probe methods are only forwarded when present, so
 * the choreography defaults (0 clear elements, discussion not skipped, edit not
 * a no-op) apply otherwise.
 *
 * `isVideoAvailable`, when provided, resolves an **unavailable** `play_video`
 * (no media association, or referenced bytes missing) to a **0ms** dwell so the
 * clip is skipped rather than blocking playback for up to `MAX_VIDEO_WAIT_MS` —
 * matching #854's "skip + diagnostic" failure behavior. Availability is decided
 * up front (via the {@link AssetSource}) because `resolveActionTimeline` fixes
 * dwell before asset planning runs; a silent cap here would shift every later
 * action by minutes.
 */
export function buildTimelineOptions(
  probe: TimingProbe,
  config: CompileConfig = {},
  isVideoAvailable?: (action: PlayVideoAction) => boolean,
): ResolveTimelineOptions {
  return {
    playbackSpeed: config.playbackSpeed ?? 1,
    whiteboardOpen: config.whiteboardInitiallyOpen ?? false,
    // The exporter degrades over failing the whole compile, so default to 'cap'
    // (assume the safety cap) rather than the choreography default of 'throw'.
    onUnresolvedVideoDuration: config.onUnresolvedVideoDuration ?? 'cap',
    getAudioDurationMs: (action) => probe.audioDurationMs(action),
    getVideoDurationMs: (action) =>
      isVideoAvailable && !isVideoAvailable(action) ? 0 : probe.videoDurationMs(action),
    ...(probe.clearElementCount
      ? { getClearElementCount: (a) => probe.clearElementCount!(a) }
      : {}),
    ...(probe.isDiscussionSkipped
      ? { isDiscussionSkipped: (a) => probe.isDiscussionSkipped!(a) }
      : {}),
    ...(probe.isEditCodeNoop ? { isEditCodeNoop: (a) => probe.isEditCodeNoop!(a) } : {}),
  };
}
