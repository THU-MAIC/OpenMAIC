'use client';

import { isBrowserPersistenceEnabled } from '@/lib/persistence/bootstrap';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store';
import { getWhiteboardRuntimeService } from './store';

export async function refreshWhiteboardRuntimeProjection(
  stageId: string,
  minimumLastSeq?: number,
): Promise<boolean> {
  if (!isBrowserPersistenceEnabled()) {
    useCanvasStore.getState().clearRuntimeWhiteboardProjection();
    return false;
  }

  const generation = useCanvasStore.getState().beginRuntimeWhiteboardProjection(stageId);
  try {
    const state = await getWhiteboardRuntimeService().read(stageId);
    const canvas = useCanvasStore.getState();
    if (
      useStageStore.getState().stage?.id !== stageId ||
      canvas.runtimeWhiteboardProjectionGeneration !== generation ||
      (minimumLastSeq !== undefined && (state.lastSeq ?? -1) < minimumLastSeq)
    ) {
      return false;
    }
    const current = canvas.runtimeWhiteboardProjection;
    if (
      current?.stageId === stageId &&
      current.lastSeq !== null &&
      (state.lastSeq === null || current.lastSeq > state.lastSeq)
    ) {
      return false;
    }
    canvas.setRuntimeWhiteboardProjection({
      stageId,
      lastSeq: state.lastSeq,
      whiteboard: state.whiteboard,
    });
    return true;
  } catch {
    return false;
  }
}
