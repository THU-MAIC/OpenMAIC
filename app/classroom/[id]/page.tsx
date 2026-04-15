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
import { isMediaPlaceholder } from '@/lib/store/media-generation';

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

async function fetchAllScenesFromStorage(stageId: string): Promise<Scene[] | null> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) return null;
    const url = `${supabaseUrl}/storage/v1/object/public/courses/${stageId}/content.json`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const { scenes } = (await res.json()) as { scenes: Scene[] };
    return (scenes ?? []).slice().sort((a, b) => a.order - b.order);
  } catch {
    return null;
  }
}

function hasUnresolvedMedia(scene: Scene): boolean {
  // Slide media placeholders
  if (scene.type === 'slide') {
    const elements =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((scene.content as any)?.canvas?.elements as Array<{ type?: string; src?: string }> | undefined) ??
      [];
    for (const el of elements) {
      if ((el.type === 'image' || el.type === 'video') && typeof el.src === 'string') {
        if (isMediaPlaceholder(el.src)) return true;
      }
    }
  }

  // TTS placeholders (no audioUrl yet)
  const actions = (scene.actions ?? []) as Array<{ type?: string; audioUrl?: string; text?: string }>;
  for (const a of actions) {
    if (a.type === 'speech' && a.text && !a.audioUrl) return true;
  }

  return false;
}

function shouldUpdateFromRemote(localScene: Scene, remoteScene: Scene): boolean {
  // If remote still has placeholders, nothing to do.
  if (hasUnresolvedMedia(remoteScene)) {
    // But remote might still have audioUrl updates even if some other element unresolved.
    // We'll compare below anyway.
  }

  // Compare speech audioUrl presence
  const localSpeechUrls = new Set(
    (localScene.actions ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((a: any) => a?.type === 'speech' && a?.text)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => a.audioUrl)
      .filter(Boolean),
  );
  const remoteSpeechUrls = new Set(
    (remoteScene.actions ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((a: any) => a?.type === 'speech' && a?.text)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => a.audioUrl)
      .filter(Boolean),
  );
  if (remoteSpeechUrls.size > localSpeechUrls.size) return true;

  // Compare slide element src upgrades (placeholder -> URL)
  if (localScene.type === 'slide' && remoteScene.type === 'slide') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const localEls = ((localScene.content as any)?.canvas?.elements as any[]) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remoteEls = ((remoteScene.content as any)?.canvas?.elements as any[]) ?? [];

    const localById = new Map<string, string>();
    for (const el of localEls) {
      if (el?.id && typeof el.src === 'string') localById.set(String(el.id), el.src);
    }
    for (const el of remoteEls) {
      const id = el?.id ? String(el.id) : null;
      if (!id || typeof el.src !== 'string') continue;
      const localSrc = localById.get(id);
      if (typeof localSrc === 'string' && isMediaPlaceholder(localSrc) && !isMediaPlaceholder(el.src)) {
        return true;
      }
    }
  }

  return false;
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
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const reconcileMediaFromStorage = useCallback(async () => {
    const { stage, scenes, currentSceneId } = useStageStore.getState();
    if (!stage?.id || scenes.length === 0) return false;

    // Quick exit: if nothing in-memory has unresolved media, don't spam storage.
    const needsReconcile = scenes.some((s) => hasUnresolvedMedia(s));
    if (!needsReconcile) return false;

    const remoteScenes = await fetchAllScenesFromStorage(stage.id);
    if (!remoteScenes || remoteScenes.length === 0) return false;

    const localByOrder = new Map(scenes.map((s) => [s.order, s] as const));
    let changed = false;
    const merged: Scene[] = scenes.map((local) => {
      const remote = localByOrder.get(local.order) ? remoteScenes.find((r) => r.order === local.order) : undefined;
      if (!remote) return local;
      if (!shouldUpdateFromRemote(local, remote)) return local;
      changed = true;
      return remote;
    });

    if (!changed) return false;

    // Preserve currentSceneId if possible.
    useStageStore.getState().setScenes(merged);
    if (currentSceneId) {
      const stillExists = merged.some((s) => s.id === currentSceneId);
      if (stillExists) useStageStore.getState().setCurrentSceneId(currentSceneId);
    }
    await useStageStore.getState().saveToStorage();
    log.info('[Classroom] Reconciled media/TTS updates from Storage into IndexedDB.');
    return true;
  }, []);

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
    if (reconcileTimerRef.current) {
      clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
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
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
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
          enableTTS: true, // TTS controlled by server env config
          enableImageGeneration: true, // media controlled by server env config
          enableVideoGeneration: true,
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

            // While the Temporal job is running, media & TTS may appear later for existing scenes.
            // Reconcile periodically so the currently open classroom updates without refresh.
            // We keep this lightweight by only fetching when local scenes still contain placeholders.
            if (!done) {
              reconcileMediaFromStorage().catch(() => {
                /* non-fatal */
              });
            }

            if (done) {
              temporalJobIdRef.current = null;
              if (status.status === 'succeeded') {
                log.info('[Classroom] Temporal remaining-job completed');
                // One final reconcile to ensure media URLs are persisted locally.
                await reconcileMediaFromStorage().catch(() => {
                  /* non-fatal */
                });
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

      // Also reconcile server-generated media/TTS (if a worker is producing URLs)
      // so an actively-open course gets the update without a reload.
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
      const tick = async () => {
        const updated = await reconcileMediaFromStorage().catch(() => false);
        // If nothing left to reconcile, stop scheduling.
        if (!updated) {
          const { scenes } = useStageStore.getState();
          const stillPending = scenes.some((s) => hasUnresolvedMedia(s));
          if (!stillPending) return;
        }
        reconcileTimerRef.current = setTimeout(tick, 6000);
      };
      reconcileTimerRef.current = setTimeout(tick, 2000);

      // All scenes are already complete — fire a full re-sync to capture any scenes that
      // were generated after the initial preview-page sync (which only had the first scene).
      syncFullCourse();
    }
  }, [loading, error, generateRemaining, syncFullCourse, syncAfterScene, reconcileMediaFromStorage]);

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
