'use client';

import Canvas from '@/components/slide-renderer/Editor/Canvas';
import { SlideHistoryRestorePrompt } from '@/components/edit/SlideHistoryRestorePrompt';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useSlideCanvasController } from './use-slide-surface';

/**
 * The slide surface's canvas. Reuses the unmodified slide renderer
 * (`components/slide-renderer/Editor/Canvas`) but wraps it in a
 * surface-controlled scene context so every renderer commit funnels into
 * the surface's staged op history instead of the live stage store.
 */
export function SlideCanvas() {
  const { controller, restorePrompt, gestureProps } = useSlideCanvasController();

  return (
    <>
      {/* gestureProps marks pointer-gesture windows so a renderer commit
          is classified as a real user edit vs ResizeObserver text
          normalization (which fires with no gesture in flight). */}
      <div className="h-full w-full" {...gestureProps}>
        <SceneProvider controller={controller}>
          <Canvas />
        </SceneProvider>
      </div>
      <SlideHistoryRestorePrompt
        open={restorePrompt.open}
        onRestore={restorePrompt.onRestore}
        onDiscard={restorePrompt.onDiscard}
        onOpenChange={restorePrompt.onOpenChange}
      />
    </>
  );
}
