'use client';

import { Component, type ReactNode } from 'react';
import { Stage } from '@/components/stage';
import { LessonPlanPlayer } from '@/components/lesson-plan-player';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';

class ClassroomErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 bg-gray-50 dark:bg-gray-900">
        <p className="text-destructive font-semibold">Classroom render error</p>
        <pre className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 max-w-xl w-full overflow-auto whitespace-pre-wrap break-all">
          {error.message}{'\n\n'}{error.stack}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 text-sm"
        >
          Retry
        </button>
      </div>
    );
  }
}

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  const { loadFromStorage } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(async () => {
    try {
      await loadFromStorage(classroomId);

      // If IndexedDB had no data, try server-side storage (API-generated classrooms)
      if (!useStageStore.getState().stage) {
        log.info('No IndexedDB data, trying server-side storage for:', classroomId);
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.classroom) {
              const { stage, scenes } = json.classroom;
              if (!stage || !Array.isArray(scenes)) {
                log.warn('Malformed classroom data from server:', classroomId);
              } else {
                useStageStore.getState().setStage(stage);
                useStageStore.setState({
                  scenes,
                  currentSceneId: scenes[0]?.id ?? null,
                });
                log.info('Loaded from server-side storage:', classroomId);

                // Agent configs from server are informational only; no registry to populate.
              }
            }
          }
        } catch (fetchErr) {
          log.warn('Server-side storage fetch failed:', fetchErr);
        }
      }

      // Restore completed media generation tasks from IndexedDB
      await useMediaGenerationStore.getState().restoreFromDB(classroomId);
      // Set preset agent IDs from stage data (orchestration registry removed)
      const { useSettingsStore } = await import('@/lib/store/settings');
      {
        const stage = useStageStore.getState().stage;
        const stageAgentIds = stage?.agentIds;
        const defaultIds = ['default-1', 'default-2', 'default-3'];
        const agentIds = stageAgentIds && stageAgentIds.length > 0 ? stageAgentIds : defaultIds;
        useSettingsStore.getState().setAgentMode('preset');
        useSettingsStore.getState().setSelectedAgentIds(agentIds);
      }
    } catch (error) {
      log.error('Failed to load classroom:', error);
      setError(error instanceof Error ? error.message : 'Failed to load classroom');
    } finally {
      setLoading(false);
    }
  }, [classroomId, loadFromStorage]);

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    setLoading(true);
    setError(null);
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    loadClassroom();

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;

    const state = useStageStore.getState();
    const { outlines = [], scenes = [], stage } = state;

    // Check if there are pending outlines
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const params = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Reconstruct imageMapping from IndexedDB using pdfImages storageIds
      const storageIds = (params.pdfImages || [])
        .map((img: { storageId?: string }) => img.storageId)
        .filter(Boolean);

      loadImageMapping(storageIds).then((imageMapping) => {
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            language: stage.language,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
        });
      });
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      generateMediaForOutlines(outlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [loading, error, generateRemaining]);

  const stageState = useStageStore.getState();
  const isLessonPlan = !loading && !error && stageState.stage?.style === 'lesson_plan';
  const lessonScene = isLessonPlan ? stageState.scenes[0] : null;

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <ClassroomErrorBoundary>
        <div className="h-screen flex flex-col overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center text-muted-foreground">
                <p>Loading classroom...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center">
                <p className="text-destructive mb-4">Error: {error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : isLessonPlan && stageState.stage && lessonScene ? (
            <LessonPlanPlayer stage={stageState.stage} scene={lessonScene} />
          ) : isLessonPlan ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <p className="text-muted-foreground">No lesson content found.</p>
            </div>
          ) : (
            <Stage onRetryOutline={retrySingleOutline} />
          )}
        </div>
        </ClassroomErrorBoundary>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
