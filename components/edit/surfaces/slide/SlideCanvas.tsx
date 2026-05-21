'use client';

import Canvas from '@/components/slide-renderer/Editor/Canvas';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useSlideCanvasController } from './use-slide-surface';

/**
 * The slide surface's canvas. Reuses the unmodified slide renderer
 * (`components/slide-renderer/Editor/Canvas`) and wraps it in a
 * surface-controlled scene context so every renderer commit funnels
 * through the slide-edit-session which auto-saves it back to the
 * canonical stage store (no staging, no "restore unsaved" prompt).
 */
export function SlideCanvas() {
  const { controller, gestureProps } = useSlideCanvasController();

  return (
    // gestureProps marks pointer-gesture windows so a renderer commit is
    // classified as a real user edit vs ResizeObserver text normalization
    // (which fires with no gesture in flight).
    <div className="h-full w-full" {...gestureProps}>
      <SceneProvider controller={controller}>
        <Canvas />
      </SceneProvider>
    </div>
  );
}
