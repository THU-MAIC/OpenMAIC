/**
 * Pure absolute-time reflow for compiler-added Quiz question-list tails.
 * Authored action timing inside each scene remains unchanged; each inserted tail
 * extends its owning scene and shifts every later absolute timestamp.
 */
import type { SubtitleCue, VideoTimelineScene } from '../ir';

export interface ReflowResult {
  scenes: VideoTimelineScene[];
  subtitles: SubtitleCue[];
  totalDurationMs: number;
}

function shiftScene(scene: VideoTimelineScene, offsetMs: number, extensionMs: number) {
  const shiftTimed = <T extends { startMs: number }>(value: T): T => ({
    ...value,
    startMs: value.startMs + offsetMs,
  });
  return {
    ...scene,
    startMs: scene.startMs + offsetMs,
    durationMs: scene.durationMs + extensionMs,
    visuals: scene.visuals.map(shiftTimed),
    narration: scene.narration.map(shiftTimed),
    effects: scene.effects.map(shiftTimed),
    videos: scene.videos.map(shiftTimed),
    markers: scene.markers.map(shiftTimed),
  };
}

export function reflowQuizTimelines(
  scenes: readonly VideoTimelineScene[],
  subtitles: readonly SubtitleCue[],
  totalDurationMs: number,
  extensionsMs: readonly number[],
): ReflowResult {
  let cumulativeOffsetMs = 0;
  const offsets = scenes.map((scene, index) => {
    const offsetMs = cumulativeOffsetMs;
    const extensionMs = Math.max(0, extensionsMs[index] ?? 0);
    cumulativeOffsetMs += extensionMs;
    return { scene, offsetMs, extensionMs };
  });

  const shiftedScenes = offsets.map(({ scene, offsetMs, extensionMs }) =>
    shiftScene(scene, offsetMs, extensionMs),
  );
  const shiftedSubtitles = subtitles.map((cue) => {
    const owner = offsets.find(
      ({ scene }) =>
        scene.id === cue.sceneId &&
        cue.startMs >= scene.startMs &&
        cue.startMs < scene.startMs + scene.durationMs,
    );
    const offsetMs =
      owner?.offsetMs ?? offsets.find(({ scene }) => scene.id === cue.sceneId)?.offsetMs ?? 0;
    return { ...cue, startMs: cue.startMs + offsetMs, endMs: cue.endMs + offsetMs };
  });

  return {
    scenes: shiftedScenes,
    subtitles: shiftedSubtitles,
    totalDurationMs: totalDurationMs + cumulativeOffsetMs,
  };
}
