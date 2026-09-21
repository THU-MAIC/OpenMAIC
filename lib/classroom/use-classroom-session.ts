'use client';

import { useCallback, useEffect } from 'react';

import { clearNarrationAllocations } from '@/lib/audio/narration-allocations';
import {
  noteStageGenerationOwnership,
  useMayGenerateForStage,
} from '@/lib/classroom/generation-permission';
import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import {
  classroomGenerationOwnership,
  noteStageOwnership,
  retryWhileOwnershipUnresolved,
  type ClassroomGenerationOwnership,
} from '@/lib/classroom/stage-ownership-signal';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useStageStore } from '@/lib/store';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';

type ClassroomSurfaceVariant = 'page' | 'pane';

interface ClassroomSessionOptions {
  readonly classroomId: string;
  readonly variant: ClassroomSurfaceVariant;
  readonly stopGeneration: () => void;
}

interface ClassroomSession {
  readonly mayGenerate: boolean;
  readonly refreshOwnership: (isCurrent: () => boolean) => void;
}

/**
 * Own the state that belongs to one mounted course, independently of whether
 * the shared classroom surface is hosted by the standalone page or workspace.
 */
export function useClassroomSession({
  classroomId,
  variant,
  stopGeneration,
}: ClassroomSessionOptions): ClassroomSession {
  const mayGenerate = useMayGenerateForStage(classroomId);

  const refreshOwnership = useCallback(
    (isCurrent: () => boolean) => {
      if (!isCurrent() || !isServerBackedMediaPersistence()) return;

      const askOwnership = async (): Promise<ClassroomGenerationOwnership> => {
        try {
          const result = await fetchStageMeta(classroomId);
          if (!isCurrent()) return 'unresolved';
          const ownership = classroomGenerationOwnership(result);
          noteStageGenerationOwnership(classroomId, ownership);

          // The standalone route also uses the sidecar to set edit access. The
          // hosted pane owns that decision at its workspace boundary.
          if (variant === 'page') {
            if (result.outcome === 'found') {
              noteStageOwnership(classroomId, true, { isOwner: result.meta.isOwner });
              useStageStore.getState().setViewerAccess({ isOwner: result.meta.isOwner });
            } else if (result.outcome === 'unavailable') {
              noteStageOwnership(classroomId, false, null);
            } else {
              noteStageOwnership(classroomId, true, null);
            }
          }
          return ownership;
        } catch {
          if (!isCurrent()) return 'unresolved';
          noteStageGenerationOwnership(classroomId, 'unresolved');
          if (variant === 'page') noteStageOwnership(classroomId, false, null);
          return 'unresolved';
        }
      };

      void retryWhileOwnershipUnresolved(askOwnership, { isCurrent });
    },
    [classroomId, variant],
  );

  useEffect(() => {
    // A course must earn its own ownership answer. It must not inherit one
    // from a prior mount of the same surface.
    noteStageGenerationOwnership(classroomId, 'unresolved');

    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });
    clearPendingMediaAllocations(classroomId);
    clearNarrationAllocations(classroomId);
    useWhiteboardHistoryStore.getState().clearHistory();
    useCanvasStore.getState().resetCanvasState();

    return () => stopGeneration();
  }, [classroomId, stopGeneration]);

  return { mayGenerate, refreshOwnership };
}
