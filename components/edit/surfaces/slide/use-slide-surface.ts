'use client';

import { produce } from 'immer';
import { Image as ImageIcon, Type } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { SceneDataController } from '@/lib/contexts/scene-context';
import type { InsertPaletteItem, SurfaceState } from '@/lib/edit/scene-editor-surface';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createElementId } from '@/lib/edit/element-id';
import { createDefaultImageElement, createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import { defaultRichTextAttrs } from '@/lib/prosemirror/utils';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { SlideContent } from '@/lib/types/stage';
import { ImagePicker } from './ImagePicker';
import { useSlideEditSession } from './slide-edit-session';
import { resolveEditingElementId, resolveSelectedElement } from './editing-state';

export interface SlideSelection {
  readonly activeElementIds: readonly string[];
}

export function buildInsertItems(
  t: (k: string) => string,
  // The currently-armed creating type, or undefined when nothing is armed. The
  // text item toggles `creatingElement` (no auto-insert): the renderer's
  // ElementCreateSelection then captures the canvas click/drag and the text
  // branch in useInsertFromCreateSelection adds the element at that rect.
  creatingType?: string,
): InsertPaletteItem[] {
  const armText = () => {
    const cs = useCanvasStore.getState();
    cs.setCreatingElement(creatingType === 'text' ? null : { type: 'text' });
  };
  return [
    {
      id: 'insert-text',
      label: t('edit.insert.textBox'),
      tooltip: t('edit.insert.textBox'),
      icon: React.createElement(Type, { className: 'h-4 w-4' }),
      active: creatingType === 'text',
      onInvoke: armText,
    },
    {
      id: 'insert-image',
      label: t('edit.insert.image'),
      tooltip: t('edit.insert.image'),
      icon: React.createElement(ImageIcon, { className: 'h-4 w-4' }),
      onInvoke: () => {}, // popover-only: CommandBar's InsertButton ignores onInvoke when popoverContent is set
      popoverContent: () =>
        React.createElement(ImagePicker, {
          onPick: insertImageElement,
        }),
    },
  ];
}

// Default insertion size for an image whose natural dimensions are unknown
// (e.g. the URL fails to load). Larger sizes get scaled to fit under MAX_W /
// MAX_H while preserving the natural aspect ratio.
const IMAGE_MAX_W = 600;
const IMAGE_MAX_H = 400;

/**
 * Insert an image element, sized to preserve the source's natural aspect
 * ratio (scaled down to fit MAX_W × MAX_H, never upscaled). The op is
 * dispatched on `Image` load; if the source fails to load, we still insert
 * at the factory's hardcoded default so the user sees something.
 */
export function insertImageElement(src: string): void {
  const id = createElementId('image');
  // Bind the insert to the scene that was active at click time. Image
  // sizing is resolved asynchronously (Image.onload), and the user may
  // switch slides before it resolves — without this guard the element
  // would be applied to whatever session is current when onload fires,
  // i.e. inserted into the wrong slide.
  const targetSceneId = useSlideEditSession.getState().sceneId;
  const dispatch = (width?: number, height?: number) => {
    if (useSlideEditSession.getState().sceneId !== targetSceneId) return;
    const base = createDefaultImageElement(id, src);
    const element = width && height ? { ...base, width, height } : base;
    useSlideEditSession.getState().applyOp({ type: 'element.add', element });
  };
  if (typeof window === 'undefined') {
    dispatch();
    return;
  }
  const img = new window.Image();
  img.onload = () => {
    const ratio = img.naturalWidth / img.naturalHeight;
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (width > IMAGE_MAX_W) {
      width = IMAGE_MAX_W;
      height = width / ratio;
    }
    if (height > IMAGE_MAX_H) {
      height = IMAGE_MAX_H;
      width = height * ratio;
    }
    dispatch(Math.round(width), Math.round(height));
  };
  img.onerror = () => dispatch();
  img.src = src;
}

/** Delete a slide element and clear the canvas selection. */
export function deleteSlideElement(elementId: string): void {
  useSlideEditSession.getState().applyOp({ type: 'element.delete', elementId });
  useCanvasStore.getState().setActiveElementIdList([]);
}

const EMPTY_SLIDE: SlideContent = { type: 'slide', canvas: createDefaultSlide('') };

function currentSlideContent(sceneId: string): SlideContent | null {
  const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
  return scene && scene.type === 'slide' ? (scene.content as SlideContent) : null;
}

/**
 * Resolves the slide content the surface should read from: the in-memory
 * edit-session present, else the canonical stage scene, else an empty slide.
 */
export function useResolvedSlideContent(): SlideContent {
  const history = useSlideEditSession((s) => s.history);
  const sessionSceneId = useSlideEditSession((s) => s.sceneId);
  return (
    history?.present ?? (sessionSceneId ? currentSlideContent(sessionSceneId) : null) ?? EMPTY_SLIDE
  );
}

/**
 * The slide surface's `useSurfaceState`. Pure read over the shared
 * session store + the renderer's selection store.
 */
export function useSlideSurfaceState(): SurfaceState<SlideContent, SlideSelection> {
  const { t } = useI18n();
  const history = useSlideEditSession((s) => s.history);
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const creatingElement = useCanvasStore.use.creatingElement();
  const content = useResolvedSlideContent();

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
    insertItems: buildInsertItems(t, creatingElement?.type),
    // Every element type carries its own actions on a selection-anchored bar
    // (AnchoredTextBar / AnchoredDeleteBar) — the surface contributes no
    // top-center FloatingToolbar actions.
    floatingActions: [],
    commands: [],
    hints: [],
  };
}

interface SlideCanvasController {
  readonly controller: SceneDataController;
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
 * Owns the edit-entry lifecycle for the slide canvas: seeds the in-memory
 * undo history from the live scene and exposes the scene-context
 * controller. The controller's writes flow through `slide-edit-session`
 * which auto-saves them to the canonical `useStageStore` (no staging, no
 * "restore unsaved" UX — the stage store is the source of truth).
 */
export function useSlideCanvasController(): SlideCanvasController {
  const sceneId = useStageStore((s) => {
    const scene = s.scenes.find((x) => x.id === s.currentSceneId) ?? null;
    return scene && scene.type === 'slide' ? scene.id : '';
  });
  // Re-render (and thus re-feed SceneProvider's getSnapshot) on every
  // history move (apply / commit / undo / redo).
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

  useEffect(() => {
    if (!sceneId) return;
    const content = currentSlideContent(sceneId);
    if (content && useSlideEditSession.getState().sceneId !== sceneId) {
      useSlideEditSession.getState().seed(sceneId, content);
    }
  }, [sceneId]);

  useEffect(() => () => useSlideEditSession.getState().end(), []);

  const controller = useMemo<SceneDataController>(
    () => ({
      sceneId,
      sceneType: 'slide',
      // Read from the canonical stage store; the session writes through to
      // it on every history move so this is always the up-to-date content.
      getSnapshot: () => currentSlideContent(sceneId) ?? EMPTY_SLIDE,
      updateSceneData: (updater) => {
        const base =
          useSlideEditSession.getState().history?.present ?? currentSlideContent(sceneId);
        if (!base) return;
        const next = produce(base, updater as (draft: SlideContent) => void);
        useSlideEditSession.getState().commitContent(next, gestureRef.current);
      },
    }),
    [sceneId],
  );

  return {
    controller,
    gestureProps,
  };
}

/**
 * The id of the text element currently being edited — i.e. the sole selected
 * element, when it is a text element. "" means "not editing text". Drives both
 * the AnchoredTextBar and the canvas store's `editingElementId`.
 */
export function useEditingTextElementId(): string {
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const content = useResolvedSlideContent();
  return resolveEditingElementId(activeElementIds, content.canvas.elements);
}

/**
 * The id of the single selected non-text element (image, shape, line, …), or
 * "" — drives the selection-anchored delete bar. Text elements get their own
 * AnchoredTextBar; every other element type shares the delete-only bar.
 */
export function useSelectedNonTextElementId(): string {
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const content = useResolvedSlideContent();
  const el = resolveSelectedElement(activeElementIds, content.canvas.elements);
  return el && el.type !== 'text' ? el.id : '';
}

/**
 * Mirrors the surface's editing-element decision into the canvas store's
 * `editingElementId` flag, which the renderer's `TextElementOperate` reads.
 * useLayoutEffect so the renderer suppresses the dashed frame in the same
 * commit the selection changes — no one-frame flicker. Cleared on unmount.
 */
export function useSyncEditingElementId(editingElementId: string): void {
  const setEditingElementId = useCanvasStore.use.setEditingElementId();
  const setRichTextAttrs = useCanvasStore.use.setRichtextAttrs();
  // Track the previous editing id so we only reset attrs on element-to-element
  // *transitions*. Resetting on the first selection (or initial mount with a
  // restored selection) would briefly flash neutral defaults — `color #000`,
  // `fontsize 16px` — before the focusing ProseMirror repopulates the real
  // values, which is more jarring than skipping the reset there.
  const prevEditingElementId = useRef('');
  useLayoutEffect(() => {
    setEditingElementId(editingElementId);
    if (prevEditingElementId.current && prevEditingElementId.current !== editingElementId) {
      // `richTextAttrs` is a single shared store updated by whichever
      // ProseMirror was last focused. Without this reset on switch, the
      // format bar visibly carries the previous element's toggle states
      // (B, I, alignment, …) until the new element's ProseMirror takes
      // focus and writes its own attrs.
      setRichTextAttrs(defaultRichTextAttrs);
    }
    prevEditingElementId.current = editingElementId;
    return () => setEditingElementId('');
  }, [editingElementId, setEditingElementId, setRichTextAttrs]);
}
