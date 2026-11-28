'use client';

import { produce } from 'immer';
import { useEffect, useMemo } from 'react';
import type { SceneDataController } from '@/lib/contexts/scene-context';
import type { SurfaceState } from '@/lib/edit/scene-editor-surface';
import { createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { SlideContent } from '@/lib/types/stage';
import { useSlideEditSession } from './slide-edit-session';

export interface SlideSelection {
  readonly activeElementIds: readonly string[];
}

/** Delete a slide element and clear the canvas selection. */
export function deleteSlideElement(elementId: string): void {
  const session = useSlideEditSession.getState();
  session.applyOp({ type: 'element.delete', elementId });
  useCanvasStore.getState().setActiveElementIdList([]);
}

/**
 * Move an element to the front (top) or back (bottom) of the z-order.
 * Two-way only — intermediate forward/backward steps stay AI's domain.
 */
export function reorderSlideElement(elementId: string, edge: 'front' | 'back'): void {
  const { sceneId } = useSlideEditSession.getState();
  const present = sceneId ? currentSlideContent(sceneId) : null;
  if (!present) return;
  const elements = present.canvas.elements;
  const currentIndex = elements.findIndex((el) => el.id === elementId);
  if (currentIndex === -1) return;
  const index = edge === 'front' ? elements.length - 1 : 0;
  // Already at the target edge — skip so we don't push an empty undo step.
  if (currentIndex === index) return;
  useSlideEditSession.getState().applyOp({ type: 'element.reorder', elementId, index });
}

const EMPTY_SLIDE: SlideContent = { type: 'slide', canvas: createDefaultSlide('') };

function currentSlideContent(sceneId: string): SlideContent | null {
  const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
  return scene && scene.type === 'slide' ? (scene.content as SlideContent) : null;
}

/**
 * Resolves the slide content the surface should read from: the canonical stage
 * scene the session is on, else an empty slide.
 */
export function useResolvedSlideContent(): SlideContent {
  const sessionSceneId = useSlideEditSession((s) => s.sceneId);
  const content = useStageStore((s) => {
    const scene = s.scenes.find((candidate) => candidate.id === sessionSceneId);
    return scene?.type === 'slide' ? (scene.content as SlideContent) : null;
  });
  return content ?? EMPTY_SLIDE;
}

/**
 * The slide surface's `useSurfaceState`. Pure read over the shared
 * session store + the renderer's selection store.
 */
export function useSlideSurfaceState(): SurfaceState<SlideContent, SlideSelection> {
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const content = useResolvedSlideContent();

  return {
    content,
    selection: { activeElementIds },
    hasSelection: activeElementIds.length > 0,
    // The package editor renders its own insert toolbar.
    insertItems: [],
    // The package editor anchors element actions to the selection, so the
    // surface contributes no top-center FloatingToolbar actions.
    floatingActions: [],
    commands: [],
    hints: [],
  };
}

interface SlideCanvasController {
  readonly controller: SceneDataController;
}

/**
 * Owns the edit-entry lifecycle for the slide canvas: points the session at the
 * live scene and exposes the scene-context controller. The controller's writes
 * flow through `slide-edit-session` to the canonical `useStageStore` (no
 * staging, no "restore unsaved" UX — the stage store is the source of truth).
 */
export function useSlideCanvasController(): SlideCanvasController {
  const sceneId = useStageStore((s) => {
    const scene = s.scenes.find((x) => x.id === s.currentSceneId) ?? null;
    return scene && scene.type === 'slide' ? scene.id : '';
  });
  // Re-render (and thus re-feed SceneProvider's getSnapshot) on every change
  // to this scene's content, whoever made it.
  useStageStore((s) => s.scenes.find((scene) => scene.id === sceneId)?.content);

  useEffect(() => {
    if (!sceneId) return;
    useSlideEditSession.getState().seed(sceneId);
  }, [sceneId]);

  useEffect(() => () => useSlideEditSession.getState().end(), []);

  const controller = useMemo<SceneDataController>(
    () => ({
      sceneId,
      sceneType: 'slide',
      // Read from the canonical stage store; the session writes through to
      // it on every history move so this is always the up-to-date content.
      getSnapshot: () => currentSlideContent(sceneId) ?? EMPTY_SLIDE,
      updateSceneData: (updater, options) => {
        const base = currentSlideContent(sceneId);
        if (!base) return;
        const next = produce(base, updater as (draft: SlideContent) => void);
        if (options?.measurement) {
          useSlideEditSession.getState().commitMeasurement(sceneId, next);
          return;
        }
        useSlideEditSession.getState().commitContent(sceneId, next);
      },
    }),
    [sceneId],
  );

  return { controller };
}
