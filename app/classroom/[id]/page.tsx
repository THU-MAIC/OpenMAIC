'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useSceneGenerator, generateAndStoreTTS } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { useSession } from 'next-auth/react';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import type { SceneOutline } from '@/lib/types/generation';
import type { SceneType } from '@/lib/types/stage';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import type { Action, SpeechAction } from '@/lib/types/action';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { SpeechButton } from '@/components/audio/speech-button';
import { SettingsDialog } from '@/components/settings';
import type { SettingsSection } from '@/lib/types/settings';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const classroomId = params?.id as string;
  const targetSceneId = searchParams.get('scene')?.trim() || null;
  const cameFromContent = searchParams.get('from') === 'content';
  const shouldPromptNewScene = searchParams.get('newScenePrompt') === '1';
  const shouldPromptEditScene = searchParams.get('editScenePrompt') === '1';
  const scenePromptMode: 'new' | 'edit' = shouldPromptEditScene ? 'edit' : 'new';
  const { data: session } = useSession();
  const canManageStudentsFromHeader =
    session?.user?.role === 'INSTRUCTOR' || session?.user?.role === 'ADMIN';
  const hasPersistAttemptedRef = useRef(false);

  const { loadFromStorage } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenePromptText, setScenePromptText] = useState('');
  const [scenePromptType, setScenePromptType] = useState<SceneType>('slide');
  const [scenePromptLanguage, setScenePromptLanguage] = useState<'zh-CN' | 'en-US' | 'th-TH'>(
    'en-US',
  );
  const [scenePromptWebSearch, setScenePromptWebSearch] = useState(false);
  const [scenePromptPdfFile, setScenePromptPdfFile] = useState<File | null>(null);
  const [scenePromptPdfError, setScenePromptPdfError] = useState<string | null>(null);
  const [scenePromptSettingsOpen, setScenePromptSettingsOpen] = useState(false);
  const [scenePromptSettingsSection, setScenePromptSettingsSection] =
    useState<SettingsSection>('providers');
  const [scenePromptOpen, setScenePromptOpen] = useState(false);
  const [scenePromptGenerating, setScenePromptGenerating] = useState(false);

  const resumeInFlightRef = useRef(false);
  const mediaResumeTriggeredRef = useRef(false);

  const persistClassroomSnapshot = useCallback(
    async (reason: string) => {
      const state = useStageStore.getState();
      if (!state.stage) return;

      try {
        const persistRes = await fetch('/api/classroom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stage: { ...state.stage, id: classroomId },
            scenes: state.scenes,
          }),
        });

        if (!persistRes.ok) {
          const payload = (await persistRes.json().catch(() => ({}))) as { error?: string };
          log.warn(`[Classroom] Failed to persist snapshot (${reason}):`, payload.error || persistRes.statusText);
        }
      } catch (persistErr) {
        log.warn(`[Classroom] Snapshot persist error (${reason}):`, persistErr);
      }
    },
    [classroomId],
  );

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onSceneGenerated: () => {
      void persistClassroomSnapshot('scene-generated');
    },
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
      void persistClassroomSnapshot('generation-complete');
    },
  });

  const buildGenerationHeaders = useCallback((): HeadersInit => {
    const config = getCurrentModelConfig();
    const settings = useSettingsStore.getState();
    const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
    const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

    return {
      'Content-Type': 'application/json',
      'x-model': config.modelString || '',
      'x-api-key': config.apiKey || '',
      'x-base-url': config.baseUrl || '',
      'x-provider-type': config.providerType || '',
      'x-requires-api-key': String(config.requiresApiKey ?? false),
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-image-api-key': imageProviderConfig?.apiKey || '',
      'x-image-base-url': imageProviderConfig?.baseUrl || '',
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-video-api-key': videoProviderConfig?.apiKey || '',
      'x-video-base-url': videoProviderConfig?.baseUrl || '',
      'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
      'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
    };
  }, []);

  const closeScenePrompt = useCallback(() => {
    setScenePromptOpen(false);
    const params = new URLSearchParams();
    if (targetSceneId) {
      params.set('scene', targetSceneId);
    }
    if (cameFromContent) {
      params.set('from', 'content');
    }
    const nextUrl = `/classroom/${classroomId}${params.toString() ? `?${params.toString()}` : ''}`;
    window.history.replaceState(null, '', nextUrl);
  }, [cameFromContent, classroomId, targetSceneId]);

  const generateSceneFromPrompt = useCallback(async () => {
    const prompt = scenePromptText.trim();
    if (!prompt || !targetSceneId) return;

    const { stage, scenes, currentSceneId, setCurrentSceneId } = useStageStore.getState();
    if (!stage) {
      setError('Stage is not loaded yet. Please retry in a moment.');
      return;
    }

    const existingScene = scenes.find((s) => s.id === targetSceneId);
    if (!existingScene) {
      setError('Target scene not found. Please retry adding a scene.');
      return;
    }

    if (currentSceneId !== targetSceneId) {
      setCurrentSceneId(targetSceneId);
    }

    setScenePromptGenerating(true);
    try {
      const summary = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
      const outline: SceneOutline = {
        id: `manual_outline_${targetSceneId}`,
        type: scenePromptType,
        title: existingScene.title?.trim() ? existingScene.title : summary,
        description: prompt,
        keyPoints: [prompt],
        order: existingScene.order,
        language: scenePromptLanguage,
      };
      const allOutlines = [outline];

      const contentRes = await fetch('/api/generate/scene-content', {
        method: 'POST',
        headers: buildGenerationHeaders(),
        body: JSON.stringify({
          outline,
          allOutlines,
          stageId: stage.id,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            language: scenePromptLanguage,
            style: stage.style,
          },
        }),
      });

      const contentData = (await contentRes.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        content?: unknown;
        effectiveOutline?: SceneOutline;
      };

      if (!contentRes.ok || !contentData.success || !contentData.content) {
        throw new Error(contentData.error || 'Failed to generate scene content');
      }

      const effectiveOutline = contentData.effectiveOutline || outline;
      const actionsRes = await fetch('/api/generate/scene-actions', {
        method: 'POST',
        headers: buildGenerationHeaders(),
        body: JSON.stringify({
          outline: effectiveOutline,
          allOutlines,
          content: contentData.content,
          stageId: stage.id,
          previousSpeeches: [],
        }),
      });

      const actionsData = (await actionsRes.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        scene?: {
          type: 'slide' | 'quiz' | 'interactive' | 'pbl';
          title: string;
          content: unknown;
          actions?: unknown;
        };
      };

      if (!actionsRes.ok || !actionsData.success || !actionsData.scene) {
        throw new Error(actionsData.error || 'Failed to generate scene actions');
      }

      // TTS: generate audio for speech actions, mirroring the normal generation pipeline
      let processedActions = actionsData.scene.actions;
      const ttsSettings = useSettingsStore.getState();
      if (ttsSettings.ttsEnabled && ttsSettings.ttsProviderId !== 'browser-native-tts') {
        const splitActions = splitLongSpeechActions(
          (actionsData.scene.actions as Action[]) || [],
          ttsSettings.ttsProviderId,
        );
        const speechActions = splitActions.filter(
          (a): a is SpeechAction => a.type === 'speech' && !!a.text,
        );
        for (const action of speechActions) {
          const audioId = `tts_${action.id}`;
          action.audioId = audioId;
          try {
            await generateAndStoreTTS(audioId, action.text);
          } catch (ttsErr) {
            log.warn('TTS generation failed for action', action.id, ttsErr);
            // Non-fatal — scene saves without audio for this action
          }
        }
        processedActions = splitActions as unknown;
      }

      const mergedScene = {
        ...existingScene,
        type: actionsData.scene.type,
        title: actionsData.scene.title || effectiveOutline.title || existingScene.title,
        content: actionsData.scene.content as never,
        actions: processedActions as never,
        updatedAt: Date.now(),
      };

      useStageStore.getState().updateScene(targetSceneId, mergedScene);

      await fetch('/api/classroom/scene', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classroomId,
          sceneId: targetSceneId,
          title: mergedScene.title,
          type: mergedScene.type,
          content: mergedScene.content,
          actions: mergedScene.actions,
        }),
      });

      closeScenePrompt();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scene');
    } finally {
      setScenePromptGenerating(false);
    }
  }, [
    buildGenerationHeaders,
    classroomId,
    closeScenePrompt,
    scenePromptLanguage,
    scenePromptText,
    scenePromptType,
    targetSceneId,
  ]);

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
              const stageWithOwnership =
                session?.user?.role === 'STUDENT'
                  ? { ...stage, ownershipType: 'invited' as const }
                  : stage;
              useStageStore.getState().setStage(stageWithOwnership);
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

      // Ensure classrooms managed by instructors/admins are persisted server-side
      // so assigned students can load the same classroom from /api/classroom.
      if (canManageStudentsFromHeader && !hasPersistAttemptedRef.current) {
        hasPersistAttemptedRef.current = true;
        try {
          const checkRes = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (checkRes.status === 404) {
            const state = useStageStore.getState();
            if (state.stage && state.scenes.length > 0) {
              await persistClassroomSnapshot('owner-ensure');
              log.info('Persisted classroom server-side:', classroomId);
            }
          }
        } catch (persistErr) {
          log.warn('Server-side classroom persist check failed:', persistErr);
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
  }, [
    classroomId,
    loadFromStorage,
    canManageStudentsFromHeader,
    persistClassroomSnapshot,
    session?.user?.role,
  ]);

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    setLoading(true);
    setError(null);
    resumeInFlightRef.current = false;
    mediaResumeTriggeredRef.current = false;

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

  // Auto-resume generation for pending outlines until completion.
  useEffect(() => {
    if (loading || error) return;

    const tick = () => {
      if (resumeInFlightRef.current) return;

      const state = useStageStore.getState();
      const { outlines, scenes, stage, failedOutlines } = state;
      if (!stage || outlines.length === 0) return;

      const completedOrders = new Set(scenes.map((s) => s.order));
      const hasPending = outlines.some((o) => !completedOrders.has(o.order));

      if (hasPending) {
        // If there are explicit failed outlines, keep paused for manual retry.
        if (failedOutlines.length > 0) return;

        resumeInFlightRef.current = true;

        const genParamsStr = sessionStorage.getItem('generationParams');
        const params = genParamsStr ? JSON.parse(genParamsStr) : {};

        const storageIds = (params.pdfImages || [])
          .map((img: { storageId?: string }) => img.storageId)
          .filter(Boolean);

        loadImageMapping(storageIds)
          .then((imageMapping) =>
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
            }),
          )
          .catch((err) => {
            log.warn('[Classroom] Resume generation error:', err);
          })
          .finally(() => {
            resumeInFlightRef.current = false;
          });
        return;
      }

      // All scenes are done; ensure media catch-up runs once.
      if (!mediaResumeTriggeredRef.current) {
        mediaResumeTriggeredRef.current = true;
        generateMediaForOutlines(outlines, stage.id).catch((err) => {
          log.warn('[Classroom] Media generation resume error:', err);
        });
      }
    };

    tick();
    const interval = window.setInterval(tick, 2500);
    return () => window.clearInterval(interval);
  }, [loading, error, generateRemaining]);

  // If navigated with ?scene=<id>, open that scene in AI Canvas after load.
  useEffect(() => {
    if (loading || error || !targetSceneId) return;

    let cancelled = false;

    const openTargetScene = async () => {
      let { scenes, currentSceneId, setCurrentSceneId } = useStageStore.getState();

      // Freshly created scenes may exist server-side but not yet in IndexedDB cache.
      if (!scenes.some((scene) => scene.id === targetSceneId)) {
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = (await res.json()) as {
              success?: boolean;
              classroom?: {
                stage: Record<string, unknown>;
                scenes: Array<{ id: string }>;
              };
            };
            if (!cancelled && json.success && json.classroom) {
              const stageWithOwnership =
                session?.user?.role === 'STUDENT'
                  ? { ...json.classroom.stage, ownershipType: 'invited' as const }
                  : json.classroom.stage;
              useStageStore.getState().setStage(stageWithOwnership as never);
              useStageStore.setState({
                scenes: json.classroom.scenes,
                currentSceneId: json.classroom.scenes[0]?.id ?? null,
              });
              ({ scenes, currentSceneId, setCurrentSceneId } = useStageStore.getState());
            }
          }
        } catch (fetchErr) {
          log.warn('Failed to refresh classroom for target scene:', fetchErr);
        }
      }

      if (cancelled) return;
      if (!scenes.some((scene) => scene.id === targetSceneId)) return;
      if (currentSceneId === targetSceneId) return;

      setCurrentSceneId(targetSceneId);
    };

    void openTargetScene();

    return () => {
      cancelled = true;
    };
  }, [loading, error, targetSceneId, classroomId, session?.user?.role]);

  useEffect(() => {
    if (!loading && !error && (shouldPromptNewScene || shouldPromptEditScene) && targetSceneId) {
      const stage = useStageStore.getState().stage;
      const scene = useStageStore.getState().scenes.find((s) => s.id === targetSceneId);
      if (scene?.type) {
        setScenePromptType(scene.type);
      }
      const stageLanguage = stage?.language;
      if (stageLanguage === 'zh-CN' || stageLanguage === 'th-TH') {
        setScenePromptLanguage(stageLanguage);
      } else if (stageLanguage === 'en' || stageLanguage === 'en-US') {
        setScenePromptLanguage('en-US');
      }
      const initialPrompt = stage?.description?.trim() || '';
      if (shouldPromptEditScene) {
        const sceneTitle = scene?.title?.trim();
        setScenePromptText(sceneTitle ? `Improve this scene: ${sceneTitle}` : 'Improve this scene: ');
      } else if (shouldPromptNewScene) {
        setScenePromptText(initialPrompt);
      }
      setScenePromptOpen(true);
    }
  }, [
    loading,
    error,
    shouldPromptEditScene,
    shouldPromptNewScene,
    targetSceneId,
  ]);

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
            <>
              <Stage onRetryOutline={retrySingleOutline} />

              {scenePromptOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm px-4">
                  <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-950/95 p-5 shadow-2xl">
                    <h2 className="text-lg font-semibold text-white">
                      {scenePromptMode === 'edit' ? 'Edit Scene with Prompt' : 'Create New Scene Content'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-400">
                      {scenePromptMode === 'edit'
                        ? 'Describe how to improve this scene. We will regenerate the current scene in AI Canvas.'
                        : 'Describe what you want for this new scene. We will generate content directly in AI Canvas.'}
                    </p>

                    <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="scene-type">
                      Scene type
                    </label>
                    <select
                      id="scene-type"
                      value={scenePromptType}
                      onChange={(e) => setScenePromptType(e.target.value as SceneType)}
                      disabled={scenePromptGenerating}
                      className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
                    >
                      <option value="slide" className="bg-slate-900 text-white">
                        Slide
                      </option>
                      <option value="quiz" className="bg-slate-900 text-white">
                        Quiz
                      </option>
                      <option value="interactive" className="bg-slate-900 text-white">
                        Interactive
                      </option>
                      <option value="pbl" className="bg-slate-900 text-white">
                        Problem-Based Learning
                      </option>
                    </select>

                    <textarea
                      value={scenePromptText}
                      onChange={(e) => setScenePromptText(e.target.value)}
                      placeholder="e.g. Explain Newton's second law with one worked example and a short quiz"
                      rows={6}
                      className="mt-4 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />

                    <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
                      <div className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <GenerationToolbar
                            language={scenePromptLanguage}
                            onLanguageChange={setScenePromptLanguage}
                            webSearch={scenePromptWebSearch}
                            onWebSearchChange={setScenePromptWebSearch}
                            onSettingsOpen={(section) => {
                              setScenePromptSettingsSection(section ?? 'providers');
                              setScenePromptSettingsOpen(true);
                            }}
                            pdfFile={scenePromptPdfFile}
                            onPdfFileChange={setScenePromptPdfFile}
                            onPdfError={setScenePromptPdfError}
                          />
                        </div>
                        <SpeechButton
                          size="md"
                          disabled={scenePromptGenerating}
                          onTranscription={(text) => {
                            setScenePromptText((prev) => `${prev}${prev ? ' ' : ''}${text}`);
                          }}
                        />
                      </div>
                      {scenePromptPdfError && (
                        <p className="mt-2 text-xs text-amber-300">{scenePromptPdfError}</p>
                      )}
                    </div>

                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={closeScenePrompt}
                        disabled={scenePromptGenerating}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10 disabled:opacity-50"
                      >
                        Skip for now
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void generateSceneFromPrompt();
                        }}
                        disabled={!scenePromptText.trim() || scenePromptGenerating}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {scenePromptGenerating
                          ? 'Generating...'
                          : scenePromptMode === 'edit'
                            ? 'Regenerate Scene'
                            : 'Generate Scene'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <SettingsDialog
                open={scenePromptSettingsOpen}
                onOpenChange={setScenePromptSettingsOpen}
                initialSection={scenePromptSettingsSection}
              />
            </>
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
