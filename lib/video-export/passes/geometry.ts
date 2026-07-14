/**
 * `geometry` pass — resolve each effect and video segment's `elementId` to
 * viewBox coords.
 *
 * Spotlight/laser effects and `play_video` clips both target a slide element;
 * the exporter needs the element's 0–100 geometry (and, for video, rotation) to
 * place them. This pass looks the element up on the scene's canvas via the pure
 * {@link findElementGeometry} / {@link findElementPlacement}. A miss (element
 * gone, or a non-slide scene with no canvas) does not throw: the segment is kept
 * with `geometry: null`, marked `degraded`, and an `unresolved-element`
 * diagnostic is recorded so the export report shows what could not be placed.
 *
 * Pure: no IO; reads only the scene's canvas elements.
 */
import type { PPTElement } from '@openmaic/dsl';
import type { CompilerScene } from '../deps';
import { findElementGeometry, findElementPlacement } from '../geometry';
import type { Diagnostic, EffectSegment, VideoSegment, VideoTimelineScene } from '../ir';

export interface GeometryResult {
  scenes: VideoTimelineScene[];
  diagnostics: Diagnostic[];
}

/**
 * Resolve a single effect's geometry against a slide's elements. Returns the
 * enriched effect (never throws); `degraded: true` + `geometry: null` when the
 * element could not be located.
 */
export function resolveEffectGeometry(
  effect: EffectSegment,
  elements: readonly PPTElement[] | undefined,
): { effect: EffectSegment; unresolved: boolean } {
  const geometry = elements ? findElementGeometry([...elements], effect.elementId) : null;
  if (geometry) return { effect: { ...effect, geometry, degraded: false }, unresolved: false };
  return { effect: { ...effect, geometry: null, degraded: true }, unresolved: true };
}

/**
 * Resolve a video segment's placement (geometry + rotation). Returns the
 * enriched segment (never throws); `degraded: true` + `geometry: null` +
 * `rotate: 0` when the element could not be located.
 */
export function resolveVideoPlacement(
  video: VideoSegment,
  elements: readonly PPTElement[] | undefined,
): { video: VideoSegment; unresolved: boolean } {
  const placement = elements ? findElementPlacement([...elements], video.elementId) : null;
  if (placement) {
    return {
      video: { ...video, geometry: placement.geometry, rotate: placement.rotate, degraded: false },
      unresolved: false,
    };
  }
  return { video: { ...video, geometry: null, rotate: 0, degraded: true }, unresolved: true };
}

/**
 * Fill every effect and video segment's geometry across all scenes.
 * `timelineScenes` and `sourceScenes` are aligned by index (both are the
 * normalized scene list).
 */
export function applyGeometry(
  timelineScenes: readonly VideoTimelineScene[],
  sourceScenes: readonly CompilerScene[],
): GeometryResult {
  const diagnostics: Diagnostic[] = [];

  const scenes = timelineScenes.map((scene, index) => {
    if (scene.effects.length === 0 && scene.videos.length === 0) return scene;

    const elements = sourceScenes[index]?.content?.canvas?.elements;

    const effects = scene.effects.map((effect) => {
      const { effect: resolved, unresolved } = resolveEffectGeometry(effect, elements);
      if (unresolved) {
        diagnostics.push({
          severity: 'warn',
          code: 'unresolved-element',
          sceneId: scene.id,
          actionId: effect.actionId,
          message: `${effect.type} target element "${effect.elementId}" has no geometry; effect degraded.`,
        });
      }
      return resolved;
    });

    const videos = scene.videos.map((video) => {
      const { video: resolved, unresolved } = resolveVideoPlacement(video, elements);
      if (unresolved) {
        diagnostics.push({
          severity: 'warn',
          code: 'unresolved-element',
          sceneId: scene.id,
          actionId: video.actionId,
          message: `play_video target element "${video.elementId}" has no geometry; placement degraded.`,
        });
      }
      return resolved;
    });

    return { ...scene, effects, videos };
  });

  return { scenes, diagnostics };
}
