'use client';

import { produce } from 'immer';
import { Move } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearPersistedSlideHistory,
  loadPersistedSlideHistory,
} from '@/lib/edit/slide-history-persistence';
import type { SceneDataController } from '@/lib/contexts/scene-context';
import type { FloatingAction, SurfaceState } from '@/lib/edit/scene-editor-surface';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { PPTElement } from '@/lib/types/slides';
import type { SlideContent } from '@/lib/types/stage';
import { GeometryPopover } from './GeometryPopover';
import { useSlideEditSession } from './slide-edit-session';

export interface SlideSelection {
  readonly activeElementIds: readonly string[];
}

const EMPTY_SLIDE: SlideContent = { type: 'slide', canvas: createDefaultSlide('') };

function currentSlideContent(sceneId: string): SlideContent | null {
  const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
  return scene && scene.type === 'slide' ? (scene.content as SlideContent) : null;
}

/**
 * The slide surface's `useSurfaceState`. Pure read over the shared
 * session store + the renderer's selection store; the only PR1 editing
 * affordance is the geometry numeric popover (canvas drag-resize is the
 * primary path and flows through the scene-context bridge).
 */
export function useSlideSurfaceState(): SurfaceState<SlideContent, SlideSelection> {
  const { t } = useI18n();
  const history = useSlideEditSession((s) => s.history);
  const sessionSceneId = useSlideEditSession((s) => s.sceneId);
  const activeElementIds = useCanvasStore.use.activeElementIdList();

  const content: SlideContent =
    history?.present ??
    (sessionSceneId ? currentSlideContent(sessionSceneId) : null) ??
    EMPTY_SLIDE;

  const selectedId = activeElementIds.length === 1 ? activeElementIds[0] : null;
  const selectedEl = selectedId
    ? (content.canvas.elements.find((el) => el.id === selectedId) ?? null)
    : null;

  // Lines model geometry as start/end/points and omit height/rotate
  // (PPTLineElement = Omit<PPTBaseElement,'height'|'rotate'>); the x/y/w/h
  // /rotate panel would write meaningless props onto them, so it's only
  // offered for box-geometry elements.
  const geomTarget = selectedEl && selectedEl.type !== 'line' ? selectedEl : null;

  // No hand-written memo: the React Compiler auto-memoizes, and a manual
  // useMemo with `t` in the closure trips its "could not preserve" rule.
  const geometryAction: FloatingAction = {
    id: 'geometry',
    label: t('edit.geometry.label'),
    tooltip: t('edit.geometry.tooltip'),
    icon: React.createElement(Move, { className: 'h-4 w-4' }),
    disabled: !geomTarget,
    popoverContent: geomTarget
      ? () =>
          React.createElement(GeometryPopover, {
            element: geomTarget,
            onPatch: (patch: Partial<PPTElement>) =>
              useSlideEditSession.getState().applyOp({
                type: 'element.update',
                elementId: geomTarget.id,
                patch,
              }),
          })
      : undefined,
  };

  return {
    content,
    selection: { activeElementIds },
    hasSelection: activeElementIds.length > 0,
    history: {
      canUndo: !!history && history.past.length > 0,
      canRedo: !!history && history.future.length > 0,
      undo: () => useSlideEditSession.getState().undo(),
      redo: () => useSlideEditSession.getState().redo(),
    },
    insertItems: [],
    floatingActions: [geometryAction],
    commands: [],
    hints: [],
  };
}

interface SlideCanvasController {
  readonly controller: SceneDataController;
  readonly restorePrompt: {
    readonly open: boolean;
    readonly onRestore: () => void;
    readonly onDiscard: () => void;
    readonly onOpenChange: (open: boolean) => void;
  };
  /**
   * Spread onto the canvas wrapper. Tracks whether a pointer gesture is in
   * flight so a renderer commit can be classified as a real user edit vs
   * ResizeObserver normalization (which fires with no pointer gesture).
   */
  readonly gestureProps: {
    readonly onPointerDownCapture: () => void;
    readonly onPointerUpCapture: () => void;
    readonly onPointerCancelCapture: () => void;
  };
}

/**
 * Owns the edit-entry lifecycle for the slide canvas: seeds the session
 * from the live scene (without clobbering persisted history), drives the
 * #571 history-restore prompt, and exposes the scene-context controller
 * that funnels the unmodified renderer's commits into the op history.
 */
export function useSlideCanvasController(): SlideCanvasController {
  const sceneId = useStageStore((s) => {
    const scene = s.scenes.find((x) => x.id === s.currentSceneId) ?? null;
    return scene && scene.type === 'slide' ? scene.id : '';
  });
  // Re-render (and thus re-feed SceneProvider) whenever staged history moves.
  useSlideEditSession((s) => s.history);

  // True only while a pointer gesture is in flight. The renderer commits a
  // geometry edit synchronously inside its mouseup handler (still within
  // the gesture); its ResizeObserver text-normalization commits later with
  // no gesture. Cleared on a macrotask after pointerup so the synchronous
  // commit still observes `true`.
  const gestureRef = useRef(false);
  const gestureProps = useMemo(
    () => ({
      onPointerDownCapture: () => {
        gestureRef.current = true;
      },
      onPointerUpCapture: () => {
        setTimeout(() => {
          gestureRef.current = false;
        }, 0);
      },
      onPointerCancelCapture: () => {
        setTimeout(() => {
          gestureRef.current = false;
        }, 0);
      },
    }),
    [],
  );

  // `pendingRestore` is decided once in `seed()` (before any renderer
  // mount write), so a within-session normalization commit can't trigger
  // the prompt. `resolvedSceneId` is the scene the user already answered
  // for; deriving `open` keeps the prompt React-Compiler clean.
  const pendingRestore = useSlideEditSession((s) => s.pendingRestore);
  const [resolvedSceneId, setResolvedSceneId] = useState<string | null>(null);
  const restoreOpen = !!sceneId && resolvedSceneId !== sceneId && pendingRestore;

  useEffect(() => {
    if (!sceneId) return;
    const content = currentSlideContent(sceneId);
    if (content && useSlideEditSession.getState().sceneId !== sceneId) {
      useSlideEditSession.getState().seed(sceneId, content);
    }
  }, [sceneId]);

  useEffect(() => () => useSlideEditSession.getState().end(), []);

  const onRestore = useCallback(() => {
    const persisted = loadPersistedSlideHistory(sceneId);
    if (persisted) useSlideEditSession.getState().restore(sceneId, persisted);
    setResolvedSceneId(sceneId);
  }, [sceneId]);

  const onDiscard = useCallback(() => {
    clearPersistedSlideHistory(sceneId);
    setResolvedSceneId(sceneId);
  }, [sceneId]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) setResolvedSceneId(sceneId);
    },
    [sceneId],
  );

  const controller = useMemo<SceneDataController>(
    () => ({
      sceneId,
      sceneType: 'slide',
      getSnapshot: () =>
        useSlideEditSession.getState().history?.present ??
        currentSlideContent(sceneId) ??
        EMPTY_SLIDE,
      updateSceneData: (updater) => {
        const base = useSlideEditSession.getState().history?.present;
        if (!base) return;
        const next = produce(base, updater as (draft: SlideContent) => void);
        useSlideEditSession.getState().commitContent(next, gestureRef.current);
      },
    }),
    [sceneId],
  );

  return {
    controller,
    restorePrompt: { open: restoreOpen, onRestore, onDiscard, onOpenChange },
    gestureProps,
  };
}
