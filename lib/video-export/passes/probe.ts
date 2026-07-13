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
import type { ResolveTimelineOptions } from '../../choreography';
import type { TimingProbe, CompileConfig } from '../deps';

/**
 * Build the {@link ResolveTimelineOptions} for a compile run from the injected
 * probe and config. Optional probe methods are only forwarded when present, so
 * the choreography defaults (0 clear elements, discussion not skipped, edit not
 * a no-op) apply otherwise.
 */
export function buildTimelineOptions(
  probe: TimingProbe,
  config: CompileConfig = {},
): ResolveTimelineOptions {
  return {
    playbackSpeed: config.playbackSpeed ?? 1,
    whiteboardOpen: config.whiteboardInitiallyOpen ?? false,
    // The exporter degrades over failing the whole compile, so default to 'cap'
    // (assume the safety cap) rather than the choreography default of 'throw'.
    onUnresolvedVideoDuration: config.onUnresolvedVideoDuration ?? 'cap',
    getAudioDurationMs: (action) => probe.audioDurationMs(action),
    getVideoDurationMs: (action) => probe.videoDurationMs(action),
    ...(probe.clearElementCount
      ? { getClearElementCount: (a) => probe.clearElementCount!(a) }
      : {}),
    ...(probe.isDiscussionSkipped
      ? { isDiscussionSkipped: (a) => probe.isDiscussionSkipped!(a) }
      : {}),
    ...(probe.isEditCodeNoop ? { isEditCodeNoop: (a) => probe.isEditCodeNoop!(a) } : {}),
  };
}
