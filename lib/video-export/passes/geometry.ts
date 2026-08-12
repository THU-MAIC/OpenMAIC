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
import type { CompilerScene, GeometryProbe } from '../deps';
import { findElementGeometry, findElementPlacement } from '../geometry';
import type { Diagnostic, EffectSegment, VideoSegment, VideoTimelineScene } from '../ir';

export interface GeometryResult {
  scenes: VideoTimelineScene[];
  diagnostics: Diagnostic[];
}

/**
 * Resolve a single effect's geometry against a slide's elements. Prefers the
 * measured content-box geometry from the {@link GeometryProbe} (matches where
 * the element actually paints), falling back to the pure authored-box calc.
 * Returns the enriched effect (never throws); `degraded: true` + `geometry:
 * null` when the element could not be located at all.
 */
export function resolveEffectGeometry(
  effect: EffectSegment,
  elements: readonly PPTElement[] | undefined,
  measured?: ReturnType<GeometryProbe['contentGeometry']>,
): { effect: EffectSegment; unresolved: boolean } {
  const geometry =
    measured ?? (elements ? findElementGeometry([...elements], effect.elementId) : null);
  if (geometry) return { effect: { ...effect, geometry, degraded: false }, unresolved: false };
  return { effect: { ...effect, geometry: null, degraded: true }, unresolved: true };
}

/**
 * Resolve a video segment's placement (geometry + rotation).
 *
 * The measured content-box geometry from the {@link GeometryProbe} is the
 * element's *axis-aligned bounding box* (`getBoundingClientRect`). For an
 * unrotated element that box **is** the rendered box, so we prefer it (it carries
 * the same padding/auto-height correction the effects rely on) and emit
 * `rotate: 0`. For a rotated element the measured box already *encloses* the
 * rotation, so re-applying the authored `rotate` downstream would rotate it a
 * second time (a widened, skewed clip). To keep one source of truth and never
 * double-count, a rotated element falls back to the pure authored box — the
 * unrotated box plus its `rotate`, which reproduces the live element exactly.
 *
 * Returns the enriched segment (never throws); `degraded: true` + `geometry:
 * null` + `rotate: 0` when the element could not be located.
 */
export function resolveVideoPlacement(
  video: VideoSegment,
  elements: readonly PPTElement[] | undefined,
  measured?: ReturnType<GeometryProbe['contentGeometry']>,
): { video: VideoSegment; unresolved: boolean } {
  const placement = elements ? findElementPlacement([...elements], video.elementId) : null;
  const rotate = placement?.rotate ?? 0;
  // The measured AABB is only compatible with a zero rotation; a rotated element
  // must use its authored box so the single downstream `rotate` isn't doubled.
  const geometry = (rotate === 0 ? measured : null) ?? placement?.geometry ?? null;
  if (geometry) {
    return {
      video: { ...video, geometry, rotate, degraded: false },
      unresolved: false,
    };
  }
  return { video: { ...video, geometry: null, rotate: 0, degraded: true }, unresolved: true };
}

/**
 * Fill every effect and video segment's geometry across all scenes.
 * `timelineScenes` and `sourceScenes` are aligned by index (both are the
 * normalized scene list). When a {@link GeometryProbe} is supplied, each
 * element's rendered content-box geometry is preferred over the authored box.
 */
export function applyGeometry(
  timelineScenes: readonly VideoTimelineScene[],
  sourceScenes: readonly CompilerScene[],
  geometryProbe?: GeometryProbe,
): GeometryResult {
  const diagnostics: Diagnostic[] = [];

  const scenes = timelineScenes.map((scene, index) => {
    if (scene.effects.length === 0 && scene.videos.length === 0) return scene;

    const sourceScene = sourceScenes[index];
    const elements = sourceScene?.content?.canvas?.elements;
    const measure = (elementId: string) =>
      geometryProbe && sourceScene ? geometryProbe.contentGeometry(elementId, sourceScene) : null;

    const effects = scene.effects.map((effect) => {
      const { effect: resolved, unresolved } = resolveEffectGeometry(
        effect,
        elements,
        measure(effect.elementId),
      );
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
      const { video: resolved, unresolved } = resolveVideoPlacement(
        video,
        elements,
        measure(video.elementId),
      );
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
