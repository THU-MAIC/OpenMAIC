'use client';

import { produce } from 'immer';
import { Image as ImageIcon, Type } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectedTextFormatBar } from './text-format-bar';
import {
  clearPersistedSlideHistory,
  loadPersistedSlideHistory,
} from '@/lib/edit/slide-history-persistence';
import type { SceneDataController } from '@/lib/contexts/scene-context';
import type { FloatingAction, InsertPaletteItem, SurfaceState } from '@/lib/edit/scene-editor-surface';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createElementId } from '@/lib/edit/element-id';
import {
  createDefaultImageElement,
  createDefaultSlide,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { PPTElement, PPTTextElement } from '@/lib/types/slides';
import type { SlideContent } from '@/lib/types/stage';
import { ImagePicker } from './ImagePicker';
import { useSlideEditSession } from './slide-edit-session';

export interface SlideSelection {
  readonly activeElementIds: readonly string[];
}

export function buildInsertItems(t: (k: string) => string): InsertPaletteItem[] {
  const addElement = (element: PPTElement) =>
    useSlideEditSession.getState().applyOp({ type: 'element.add', element });
  return [
    {
      id: 'insert-text',
      label: t('edit.insert.textBox'),
      tooltip: t('edit.insert.textBox'),
      icon: React.createElement(Type, { className: 'h-4 w-4' }),
      onInvoke: () => addElement(createDefaultTextElement(createElementId('text'))),
    },
    {
      id: 'insert-image',
      label: t('edit.insert.image'),
      tooltip: t('edit.insert.image'),
      icon: React.createElement(ImageIcon, { className: 'h-4 w-4' }),
      onInvoke: () => {}, // popover-only: CommandBar's InsertButton ignores onInvoke when popoverContent is set
      popoverContent: () =>
        React.createElement(ImagePicker, {
          onPick: (src: string) => addElement(createDefaultImageElement(createElementId('image'), src)),
        }),
    },
  ];
}

export function buildFloatingActions(
  t: (k: string) => string,
  textTarget: PPTTextElement | undefined,
): FloatingAction[] {
  if (!textTarget) return [];
  // NOTE: The bar is surfaced via FloatingToolbar's popover slot (one button → popover → bar),
  // not always-inline. This is an ergonomics tradeoff to be addressed in Task 8 polish.
  return [
    {
      id: 'text-format',
      label: t('edit.text.label'),
      tooltip: t('edit.text.label'),
      popoverContent: () => React.createElement(ConnectedTextFormatBar, { elementId: textTarget.id }),
    },
  ];
}

const EMPTY_SLIDE: SlideContent = { type: 'slide', canvas: createDefaultSlide('') };

function currentSlideContent(sceneId: string): SlideContent | null {
  const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
  return scene && scene.type === 'slide' ? (scene.content as SlideContent) : null;
}

/**
 * The slide surface's `useSurfaceState`. Pure read over the shared
 * session store + the renderer's selection store.
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

  const onlyEl = activeElementIds.length === 1
    ? (content.canvas.elements.find((el) => el.id === activeElementIds[0]) ?? undefined)
    : undefined;
  const textTarget = onlyEl && onlyEl.type === 'text' ? onlyEl : undefined;

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
    insertItems: buildInsertItems(t),
    floatingActions: buildFloatingActions(t, textTarget),
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
