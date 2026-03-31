'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSceneGenerator, generateAndStoreTTS, type TTSOverrides } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { db } from '@/lib/utils/database';
import { useSettingsStore } from '@/lib/store/settings';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { setPrefillPromise, getPrefillPromise } from '@/lib/media/prefill-state';

const log = createLogger('Classroom');

/**
 * Pre-fill local IndexedDB with cached media from the server.
 * Runs async, does not block page rendering.
 */
async function prefillMediaCache(classroomId: string): Promise<void> {
  const res = await fetch(`/api/classroom/media?id=${encodeURIComponent(classroomId)}&list=true`);
  if (!res.ok) return;
  const json = await res.json();
  if (!json.success || !Array.isArray(json.files) || json.files.length === 0) return;

  const files: string[] = json.files;
  const mediaStore = useMediaGenerationStore.getState();
  const prefilledTtsIds = new Set<string>();

  for (const fileName of files) {
    const dotIdx = fileName.lastIndexOf('.');
    if (dotIdx <= 0) continue;
    const fileId = fileName.slice(0, dotIdx);
    const ext = fileName.slice(dotIdx);

    if (fileName.startsWith('tts_')) {
      // Check if already in IndexedDB
      const existing = await db.audioFiles.get(fileId);
      if (existing) {
        prefilledTtsIds.add(fileId);
        continue;
      }

      const mediaUrl = `/api/classroom/media?id=${encodeURIComponent(classroomId)}&file=${encodeURIComponent(fileId)}`;
      try {
        const blobRes = await fetch(mediaUrl);
        if (!blobRes.ok) continue;
        const blob = await blobRes.blob();
        const format = ext.replace('.', '');
        await db.audioFiles.put({
          id: fileId,
          blob,
          format,
          createdAt: Date.now(),
        });
        prefilledTtsIds.add(fileId);
        log.info('Prefilled TTS from cache:', fileId);
      } catch { /* best effort */ }
    } else if (fileName.startsWith('gen_img_') || fileName.startsWith('gen_vid_')) {
      const elementId = fileId;
      const task = mediaStore.getTask(elementId);
      if (task?.status === 'done') continue;

      const mediaUrl = `/api/classroom/media?id=${encodeURIComponent(classroomId)}&file=${encodeURIComponent(fileId)}`;
      const type = fileName.startsWith('gen_img_') ? 'image' : 'video';
      // Directly set task as done with API URL — works even if task wasn't enqueued yet
      useMediaGenerationStore.setState((s) => ({
        tasks: {
          ...s.tasks,
          [elementId]: {
            elementId,
            type: type as 'image' | 'video',
            status: 'done' as const,
            prompt: '',
            params: {},
            retryCount: 0,
            stageId: classroomId,
            objectUrl: mediaUrl,
          },
        },
      }));
      log.info('Prefilled media from cache:', elementId);
    }
  }

  // Patch audioId on speech actions whose TTS was prefilled from server cache
  if (prefilledTtsIds.size > 0) {
    const scenes = useStageStore.getState().scenes;
    let anyUpdated = false;
    const updatedScenes = scenes.map(scene => {
      const actions = scene.actions || [];
      let sceneUpdated = false;
      const newActions = actions.map(action => {
        if (action.type !== 'speech' || !('text' in action) || action.audioId) return action;
        const candidateId = `tts_${action.id}`;
        if (prefilledTtsIds.has(candidateId)) {
          sceneUpdated = true;
          return { ...action, audioId: candidateId };
        }
        return action;
      });
      if (!sceneUpdated) return scene;
      anyUpdated = true;
      return { ...scene, actions: newActions };
    });
    if (anyUpdated) {
      useStageStore.getState().setScenes(updatedScenes);
      log.info('Patched audioId on scenes from prefilled TTS cache');
    }
  }
}

/**
 * Backfill TTS for completed scenes whose speech actions lack audio.
 * API-generated classrooms have speech actions but no TTS — this fills the gap.
 *
 * Key fixes over the original:
 * 1. Deep-copies scenes/actions so Zustand detects the change
 * 2. Immediately persists to IndexedDB (not relying on 500ms debounce)
 * 3. Updates server-side classroom.json so audioIds survive across browsers
 */
async function backfillMissingTTS(): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.ttsEnabled || settings.ttsProviderId === 'browser-native-tts') return;

  // Wait for prefill to finish so we don't regenerate already-cached TTS
  await getPrefillPromise();

  const scenes = useStageStore.getState().scenes;
  if (!scenes || scenes.length === 0) return;

  // Phase 1: collect all speech actions missing TTS
  const missing: { sceneIdx: number; actionIdx: number; audioId: string; text: string }[] = [];
  for (let si = 0; si < scenes.length; si++) {
    const actions = scenes[si].actions || [];
    for (let ai = 0; ai < actions.length; ai++) {
      const action = actions[ai];
      if (action.type !== 'speech' || !('text' in action) || !action.text) continue;
      const audioId = action.audioId || `tts_${action.id}`;
      const existing = await db.audioFiles.get(audioId);
      if (existing) continue;
      missing.push({ sceneIdx: si, actionIdx: ai, audioId, text: action.text });
    }
  }

  if (missing.length === 0) return;
  log.info(`Backfilling ${missing.length} missing TTS...`);

  // Snapshot TTS settings once so all items use the same voice
  const ttsProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const ttsSnapshot: TTSOverrides = {
    providerId: settings.ttsProviderId,
    voice: settings.ttsVoice,
    speed: settings.ttsSpeed,
    apiKey: ttsProviderConfig?.apiKey,
    baseUrl: ttsProviderConfig?.baseUrl,
  };

  // Phase 2: generate TTS one by one (skip failures)
  const generated: typeof missing = [];
  for (const item of missing) {
    try {
      await generateAndStoreTTS(item.audioId, item.text, undefined, ttsSnapshot);
      generated.push(item);
      log.info('Backfilled TTS:', item.audioId);
    } catch (err) {
      log.warn('Backfill TTS failed:', item.audioId, err);
    }
  }

  if (generated.length === 0) return;

  // Phase 3: deep-copy scenes and assign audioId (new object refs for Zustand)
  const updatedScenes = scenes.map((scene, si) => {
    const updates = generated.filter(g => g.sceneIdx === si);
    if (updates.length === 0) return scene;
    return {
      ...scene,
      actions: scene.actions?.map((action, ai) => {
        const upd = updates.find(u => u.actionIdx === ai);
        return upd ? { ...action, audioId: upd.audioId } : action;
      }),
    };
  });

  // Phase 4: update store + persist immediately
  useStageStore.getState().setScenes(updatedScenes);
  await useStageStore.getState().saveToStorage();
  log.info(`Backfilled ${generated.length} TTS, saved to IndexedDB`);

  // Phase 5: update server-side classroom.json (best effort)
  try {
    const state = useStageStore.getState();
    await fetch('/api/classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: state.stage,
        scenes: state.scenes,
        outlines: state.outlines,
      }),
    });
    log.info('Updated server-side classroom.json with audioIds');
  } catch { /* best effort */ }
}

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  const { loadFromStorage } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);
  const backfillStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(async () => {
    try {
      let loadedFromServer = false;

      // Published classrooms should prefer the latest server copy.
      // IndexedDB stays as an offline/cache fallback instead of being authoritative.
      try {
        const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.classroom) {
            const { stage, scenes, outlines } = json.classroom;
            useStageStore.getState().setStage(stage);
            useStageStore.setState({
              scenes,
              outlines: outlines || [],
              currentSceneId: scenes[0]?.id ?? null,
            });
            await useStageStore.getState().saveToStorage();
            loadedFromServer = true;
            log.info('Loaded latest classroom from server-side storage:', classroomId);
          }
        }
      } catch (fetchErr) {
        log.warn('Server-side storage fetch failed, falling back to IndexedDB:', fetchErr);
      }

      if (!loadedFromServer) {
        await loadFromStorage(classroomId);
        if (useStageStore.getState().stage) {
          log.info('Loaded classroom from IndexedDB fallback:', classroomId);
        }
      }

      // Restore completed media generation tasks from IndexedDB
      await useMediaGenerationStore.getState().restoreFromDB(classroomId);

      // Pre-fill media cache from server (fire-and-forget, backfill awaits this promise)
      setPrefillPromise(prefillMediaCache(classroomId).catch((err) => {
        log.warn('Media cache prefill failed:', err);
      }));

      // Restore generated agents for this stage
      const { loadGeneratedAgentsForStage } = await import('@/lib/orchestration/registry/store');
      const agentIds = await loadGeneratedAgentsForStage(classroomId);
      if (agentIds.length > 0) {
        const { useSettingsStore } = await import('@/lib/store/settings');
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
    backfillStartedRef.current = false;

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
    const { outlines, scenes, stage } = state;

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
      getPrefillPromise().then(() => {
        generateMediaForOutlines(outlines, stage.id).catch((err) => {
          log.warn('[Classroom] Media generation resume error:', err);
        });
      });
    }

    // Backfill TTS for completed scenes that lack audio (e.g. API-generated classrooms)
    if (stage && !backfillStartedRef.current) {
      backfillStartedRef.current = true;
      backfillMissingTTS().catch((err) => {
        log.warn('[Classroom] TTS backfill error:', err);
      });
    }
  }, [loading, error, generateRemaining]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
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
          ) : (
            <Stage onRetryOutline={retrySingleOutline} />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
