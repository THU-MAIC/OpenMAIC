'use client';

/**
 * Workbench Pro-mode sizing: fill the 16:9 card. The default 90% is a studio
 * margin for the full-page editor; inside the workbench that margin is a
 * second letterbox on top of the card, which is the "PPT not aligned with the
 * canvas" gap.
 *
 * (The edit-lease / hand-edit signals this hook used to carry are gone with
 * the S6 write-arbitration mechanism — scene writes are last-write-wins.)
 */
import { useEffect } from 'react';
import { useCanvasStore } from '@/lib/store/canvas';

export function useWorkbenchProEditing(): void {
  useEffect(() => {
    const prev = useCanvasStore.getState().canvasPercentage;
    useCanvasStore.getState().setCanvasPercentage(100);
    return () => {
      useCanvasStore.getState().setCanvasPercentage(prev);
    };
  }, []);
}
