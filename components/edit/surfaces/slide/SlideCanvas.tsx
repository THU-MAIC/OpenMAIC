'use client';

import { useEffect } from 'react';
import Canvas from '@/components/slide-renderer/Editor/Canvas';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import {
  useEditingTextElementId,
  useSelectedNonTextElementId,
  useSlideCanvasController,
  useSyncEditingElementId,
} from './use-slide-surface';
import { AnchoredTextBar } from './AnchoredTextBar';
import { AnchoredDeleteBar } from './AnchoredDeleteBar';

/**
 * The slide surface's canvas. Reuses the unmodified slide renderer
 * (`components/slide-renderer/Editor/Canvas`) and wraps it in a
 * surface-controlled scene context so every renderer commit funnels
 * through the slide-edit-session which auto-saves it back to the
 * canonical stage store (no staging, no "restore unsaved" prompt).
 *
 * It also owns the selection-anchored chrome: it derives the selected element,
 * mirrors a selected text element into the canvas store's `editingElementId`
 * (which the renderer reads to draw a clean frame), and renders the anchored
 * bars — the format bar for text, a delete bar for every other element type.
 * At most one bar is open at a time (single selection).
 */
export function SlideCanvas() {
  const { controller, gestureProps } = useSlideCanvasController();
  const editingElementId = useEditingTextElementId();
  const nonTextElementId = useSelectedNonTextElementId();
  useSyncEditingElementId(editingElementId);

  // Esc disarms in-flight insert mode. Read via getState so the listener mounts
  // once; checking inside the handler keeps us inert when nothing is armed.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const cs = useCanvasStore.getState();
      if (cs.creatingElement) cs.setCreatingElement(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    // gestureProps marks pointer-gesture windows so a renderer commit is
    // classified as a real user edit vs ResizeObserver text normalization
    // (which fires with no gesture in flight). The padded studio frame
    // around the canvas now lives in EditShell.Frame so non-slide scenes
    // (rendered via SceneRenderer in read-only mode) share the exact
    // same canvas bounding rect — switching scene type no longer
    // resizes / reflows the frame, which used to cause the slide↔
    // interactive layout jump.
    <div className="relative h-full w-full" {...gestureProps}>
      <SceneProvider controller={controller}>
        <Canvas />
      </SceneProvider>
      <AnchoredTextBar editingElementId={editingElementId} />
      <AnchoredDeleteBar elementId={nonTextElementId} />
    </div>
  );
}
