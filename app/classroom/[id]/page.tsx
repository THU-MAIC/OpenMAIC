'use client';

import { Stage } from '@/components/stage';
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
import { useAnalytics } from '@/lib/hooks/use-analytics';
import { useAuth } from '@/lib/hooks/use-auth';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('Classroom');

// ---------------------------------------------------------------------------
// Helpers for Temporal remaining-job polling
// ---------------------------------------------------------------------------

interface RemainingJobStatus {
  status: 'running' | 'succeeded' | 'failed';
  scenesGenerated: number;
  totalPending: number;
  completedScenes: Scene[];
  done: boolean;
  error?: string;
}

async function startRemainingJob(params: {
  stageId: string;
  requirement: string;
  enableTTS: boolean;
  enableImageGeneration: boolean;
  enableVideoGeneration: boolean;
}): Promise<string | null> {
  const { stage, outlines, scenes } = useStageStore.getState();
  if (!stage || outlines.length === 0) return null;

  // Parse agents from sessionStorage (stored by generation-preview)
  let agents: unknown[] = [];
  try {
    const genParams = sessionStorage.getItem('generationParams');
    if (genParams) agents = JSON.parse(genParams).agents ?? [];
  } catch {
    /* ignore */
  }

  const completedOrders = scenes.map((s) => s.order);
  const courseDescription = outlines[0]?.description || stage.name;

  try {
    const res = await fetch('/api/generate/remaining-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage,
        outlines,
        agents,
        completedOrders,
        courseDescription,
        enableTTS: params.enableTTS,
        enableImageGeneration: params.enableImageGeneration,
        enableVideoGeneration: params.enableVideoGeneration,
        requirement: params.requirement,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.success ? (data.jobId as string) : null;
  } catch (err) {
    log.warn('[Classroom] Failed to start Temporal remaining-job:', err);
    return null;
  }
}

async function pollRemainingJob(jobId: string): Promise<RemainingJobStatus | null> {
  try {
    const res = await fetch(`/api/generate/remaining-job/${encodeURIComponent(jobId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.success ? (data as unknown as { success: true } & RemainingJobStatus) : null;
  } catch {
    return null;
  }
}

async function fetchNewScenesFromStorage(
  stageId: string,
  knownOrders: Set<number>,
): Promise<Scene[]> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) return [];
    const url = `${supabaseUrl}/storage/v1/object/public/courses/${stageId}/content.json`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const { scenes } = (await res.json()) as { scenes: Scene[] };
    return (scenes ?? []).filter((s) => !knownOrders.has(s.order));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  useAnalytics(classroomId);

  const { loadFromStorage } = useStageStore();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);
  // Tracks whether the full re-sync (all scenes) has already been fired this session
  const fullSyncDoneRef = useRef(false);

  // Temporal remaining-job state
  const temporalJobIdRef = useRef<string | null>(null);
  const temporalPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const temporalLastScenesGeneratedRef = useRef(0);

  const syncFullCourse = useCallback(async () => {
    if (!user || fullSyncDoneRef.current) return;
    const { stage, scenes } = useStageStore.getState();
    if (!stage || scenes.length === 0) return;
    fullSyncDoneRef.current = true;
    try {
      const { uploadCourseToSupabase } = await import('@/lib/supabase/course-sync');
      await uploadCourseToSupabase({ userId: user.id, stage, scenes });
      log.info('[Classroom] Full course re-synced to Supabase with all scenes.');
    } catch (err) {
      log.warn('[Classroom] Full re-sync failed (non-fatal):', err);
    }
  }, [user]);

  const syncAfterScene = useCallback(async () => {
    if (!user) return;
    const { stage, scenes } = useStageStore.getState();
    if (!stage || scenes.length === 0) return;
    try {
      const { uploadCourseToSupabase } = await import('@/lib/supabase/course-sync');
      await uploadCourseToSupabase({ userId: user.id, stage, scenes });
      log.info(`[Classroom] Incremental sync: ${scenes.length} scene(s) saved to Supabase.`);
    } catch (err) {
      log.warn('[Classroom] Incremental scene sync failed (non-fatal):', err);
    }
  }, [user]);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onSceneGenerated: () => {
      syncAfterScene();
    },
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
      syncFullCourse();
    },
  });

  const loadClassroom = useCallback(async () => {
    try {
      await loadFromStorage(classroomId);

      // If IndexedDB had no data, try Supabase (cloud sync) or server-side storage
      if (!useStageStore.getState().stage) {
        log.info('No IndexedDB data, trying Supabase cloud storage for:', classroomId);
        try {
          const { downloadCourseByStageId } = await import('@/lib/supabase/course-sync');
          const success = await downloadCourseByStageId(classroomId);
          if (success) {
            log.info('Loaded from Supabase cloud storage:', classroomId);
            await loadFromStorage(classroomId);
          }
        } catch (sErr) {
          log.warn('Supabase cloud storage fetch failed:', sErr);
        }
      }

      // If still no data, try the legacy server-side storage
      if (!useStageStore.getState().stage) {
        log.info('Still no data, trying legacy server-side storage for:', classroomId);
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.classroom) {
              const { stage, scenes } = json.classroom;
              useStageStore.getState().setStage(stage);
              useStageStore.setState({
                scenes,
                currentSceneId: scenes[0]?.id ?? null,
              });
              log.info('Loaded from server-side storage:', classroomId);

              // Hydrate server-generated agents into IndexedDB + registry
              if (stage.generatedAgentConfigs?.length) {
                const { saveGeneratedAgents } = await import('@/lib/orchestration/registry/store');
                const { useSettingsStore } = await import('@/lib/store/settings');
                const agentIds = await saveGeneratedAgents(stage.id, stage.generatedAgentConfigs);
                useSettingsStore.getState().setSelectedAgentIds(agentIds);
                log.info('Hydrated server-generated agents:', agentIds);
              }
            }
          }
        } catch (fetchErr) {
          log.warn('Server-side storage fetch failed:', fetchErr);
        }
      }

      // Restore completed media generation tasks from IndexedDB
      await useMediaGenerationStore.getState().restoreFromDB(classroomId);
      // Restore agents for this stage
      const { loadGeneratedAgentsForStage, useAgentRegistry } =
        await import('@/lib/orchestration/registry/store');
      const generatedAgentIds = await loadGeneratedAgentsForStage(classroomId);
      const { useSettingsStore } = await import('@/lib/store/settings');
      if (generatedAgentIds.length > 0) {
        // Auto mode — use generated agents from IndexedDB
        useSettingsStore.getState().setAgentMode('auto');
        useSettingsStore.getState().setSelectedAgentIds(generatedAgentIds);
      } else {
        // Preset mode — restore agent IDs saved in the stage at creation time.
        // Filter out any stale generated IDs that may have been persisted before
        // the bleed-fix, so they don't resolve against a leftover registry entry.
        const stage = useStageStore.getState().stage;
        const stageAgentIds = stage?.agentIds;
        const registry = useAgentRegistry.getState();
        const cleanIds = stageAgentIds?.filter((id) => {
          const a = registry.getAgent(id);
          return a && !a.isGenerated;
        });
        useSettingsStore.getState().setAgentMode('preset');
        useSettingsStore
          .getState()
          .setSelectedAgentIds(
            cleanIds && cleanIds.length > 0 ? cleanIds : ['default-1', 'default-2', 'default-3'],
          );
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
    fullSyncDoneRef.current = false;
    temporalJobIdRef.current = null;
    temporalLastScenesGeneratedRef.current = 0;
    if (temporalPollTimerRef.current) {
      clearTimeout(temporalPollTimerRef.current);
      temporalPollTimerRef.current = null;
    }

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
      if (temporalPollTimerRef.current) clearTimeout(temporalPollTimerRef.current);
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;

    const state = useStageStore.getState();
    const { outlines, scenes, stage } = state;

    // Check if there are pending outlines
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const genParams = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Attempt Temporal remaining-job if Supabase is configured and we came from
      // the generation-preview flow (sessionStorage has generationParams).
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const fromPreviewFlow = !!genParamsStr;

      if (supabaseUrl && fromPreviewFlow) {
        const requirement = stage.name || 'Course';

        startRemainingJob({
          stageId: stage.id,
          requirement,
          enableTTS: false, // TTS controlled by server env config
          enableImageGeneration: false, // media controlled by server env config
          enableVideoGeneration: false,
        }).then((jobId) => {
          if (!jobId) {
            // Temporal unavailable — fall back to client-side generation
            log.info('[Classroom] Temporal unavailable, falling back to useSceneGenerator');
            const storageIds = (genParams.pdfImages || [])
              .map((img: { storageId?: string }) => img.storageId)
              .filter(Boolean);
            loadImageMapping(storageIds).then((imageMapping) => {
              generateRemaining({
                pdfImages: genParams.pdfImages,
                imageMapping,
                stageInfo: {
                  name: stage.name || '',
                  description: stage.description,
                  language: stage.language,
                  style: stage.style,
                },
                agents: genParams.agents,
                userProfile: genParams.userProfile,
              });
            });
            return;
          }

          log.info(`[Classroom] Temporal remaining-job started: ${jobId}`);
          temporalJobIdRef.current = jobId;
          temporalLastScenesGeneratedRef.current = 0;

          // Polling loop — fetch status every 4 s; when scenesGenerated grows,
          // refresh scenes from Supabase Storage.
          const poll = async () => {
            if (!temporalJobIdRef.current) return;

            const status = await pollRemainingJob(temporalJobIdRef.current);
            if (!status) {
              temporalPollTimerRef.current = setTimeout(poll, 5000);
              return;
            }

            const { scenesGenerated, done } = status;

            if (scenesGenerated > temporalLastScenesGeneratedRef.current) {
              temporalLastScenesGeneratedRef.current = scenesGenerated;

              const storeState = useStageStore.getState();
              const knownOrders = new Set(storeState.scenes.map((s) => s.order));

              // Primary: scenes carried directly in the poll response (no Supabase dependency)
              let newScenes: Scene[] = (status.completedScenes ?? []).filter(
                (s) => !knownOrders.has(s.order),
              );

              // Fallback: if poll payload is empty, try Supabase Storage content.json
              if (newScenes.length === 0 && scenesGenerated > 0) {
                newScenes = await fetchNewScenesFromStorage(stage.id, knownOrders);
              }

              for (const scene of newScenes) {
                useStageStore.getState().addScene(scene);
              }

              if (newScenes.length > 0) {
                await useStageStore.getState().saveToStorage();
                log.info(`[Classroom] Applied ${newScenes.length} new scene(s) from Temporal`);
                syncAfterScene();
              }
            }

            if (done) {
              temporalJobIdRef.current = null;
              if (status.status === 'succeeded') {
                log.info('[Classroom] Temporal remaining-job completed');
                syncFullCourse();
              } else {
                log.warn('[Classroom] Temporal remaining-job failed:', status.error);
              }
              return;
            }

            temporalPollTimerRef.current = setTimeout(poll, 4000);
          };

          // Start first poll after a short delay to let the worker pick up the job
          temporalPollTimerRef.current = setTimeout(poll, 3000);
        });
      } else {
        // No Supabase or not from preview flow — use client-side generator directly
        const storageIds = (genParams.pdfImages || [])
          .map((img: { storageId?: string }) => img.storageId)
          .filter(Boolean);

        loadImageMapping(storageIds).then((imageMapping) => {
          generateRemaining({
            pdfImages: genParams.pdfImages,
            imageMapping,
            stageInfo: {
              name: stage.name || '',
              description: stage.description,
              language: stage.language,
              style: stage.style,
            },
            agents: genParams.agents,
            userProfile: genParams.userProfile,
          });
        });
      }
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      generateMediaForOutlines(outlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });

      // All scenes are already complete — fire a full re-sync to capture any scenes that
      // were generated after the initial preview-page sync (which only had the first scene).
      syncFullCourse();
    }
  }, [loading, error, generateRemaining, syncFullCourse, syncAfterScene]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="h-[100dvh] flex flex-col overflow-hidden">
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
          ) : (
            <Stage onRetryOutline={retrySingleOutline} />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
