/**
 * Keep the editor/playback viewport in the canvas store aligned with the
 * current slide. Thumbnails already auto-fit using `slide.viewportSize`;
 * the main canvas sizes its box from the store (default 1000×16:9). Imported
 * PPTX decks are often 1280×16:9 (or 4:3), so without this sync the right
 * and bottom of the slide are clipped while the rail looks complete.
 *
 * The canvas store is a singleton, so only the active scene may write it.
 * Keep-alive / crossfade siblings that stay mounted for another scene skip
 * the write; otherwise the last effect would stretch every canvas.
 */
import { useLayoutEffect } from 'react';
import { useSceneData, useSceneSelector } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import { useCanvasStore } from './canvas';
import { useStageStore } from './stage';

const DEFAULT_VIEWPORT_SIZE = 1000;
const DEFAULT_VIEWPORT_RATIO = 0.5625;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isActiveCanvasScene(
  sceneId: string | undefined,
  currentSceneId: string | undefined | null,
): boolean {
  if (currentSceneId && sceneId && sceneId !== currentSceneId) return false;
  return true;
}

export function syncCanvasViewportFromSlide(slide: {
  viewportSize?: number;
  viewportRatio?: number;
}): boolean {
  const size = finitePositive(slide.viewportSize) ? slide.viewportSize : DEFAULT_VIEWPORT_SIZE;
  const ratio = finitePositive(slide.viewportRatio) ? slide.viewportRatio : DEFAULT_VIEWPORT_RATIO;
  const store = useCanvasStore.getState();
  if (store.viewportSize === size && store.viewportRatio === ratio) return false;
  store.setViewportSize(size);
  store.setViewportRatio(ratio);
  return true;
}

export function useSyncCanvasViewportFromSlide(): void {
  const { sceneId } = useSceneData();
  const currentSceneId = useStageStore((state) => state.currentSceneId);
  const viewportSize = useSceneSelector<SlideContent, number | undefined>(
    (content) => content.canvas?.viewportSize,
  );
  const viewportRatio = useSceneSelector<SlideContent, number | undefined>(
    (content) => content.canvas?.viewportRatio,
  );
  useLayoutEffect(() => {
    if (!isActiveCanvasScene(sceneId, currentSceneId)) return;
    syncCanvasViewportFromSlide({ viewportSize, viewportRatio });
  }, [viewportSize, viewportRatio, sceneId, currentSceneId]);
}
