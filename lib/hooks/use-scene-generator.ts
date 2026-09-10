'use client';

import { useCallback, useRef } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import type { AgentInfo } from '@openmaic/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import {
  getEnabledProvidersWithVoices,
  resolveDeterministicFallbackVoice,
  resolveNarratorVoiceBinding,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { resolveTTSModelForVoice } from '@/lib/audio/constants';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { createLogger } from '@/lib/logger';
import { toast } from 'sonner';
import { getClientTranslation } from '@/lib/i18n';
import {
  isVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  markVoiceBindingUnavailable,
  voiceBindingKey,
} from '@/lib/audio/unavailable-voice-bindings';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@openmaic/generation';

const log = createLogger('SceneGenerator');

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
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
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown },
  fallback: string,
): Error & { errorCode?: string; statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { errorCode?: string; statusCode?: number };
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function errorMeta(error: unknown): Pick<SceneContentResult, 'errorCode' | 'statusCode'> {
  if (!error || typeof error !== 'object') return {};
  const record = error as { errorCode?: unknown; statusCode?: unknown };
  return {
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        return data as unknown as SceneContentResult;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.content,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Content generation failed'),
      ...errorMeta(error),
    };
  }
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Actions generation failed'),
      ...errorMeta(error),
    };
  }
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

// A dead narrator voice is retried at most once against a DIFFERENT voice (the
// global voice when the binding differs from it, or the deterministic
// enabled-provider pick when bound == global). This bounds the total
// /api/generate/tts attempts to 2 per call and guarantees the
// QWEN_VC_VOICE_NOT_FOUND retry cannot loop a chain of dead voices
// (bound-dead → global-dead → deterministic-dead → …) forever.
const MAX_NARRATOR_VOICE_FALLBACK_HOPS = 1;

/** Generate TTS for one speech action and return its allocated asset reference. */
export async function generateAndStoreTTS(
  requestId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  existingAudioId?: string,
  stageId?: string,
  // Internal: an explicit voice that bypasses narrator binding resolution — used
  // to retry narration against the deterministic enabled-provider pick when the
  // pinned narrator voice (bound == global) turns out to be unusable.
  overrideVoice?: ResolvedVoice,
  // Internal: number of narrator voice-fallback hops already taken. Guards the
  // QWEN_VC_VOICE_NOT_FOUND retry so a chain of dead voices can never loop
  // /api/generate/tts beyond a single fallback hop.
  fallbackHops = 0,
): Promise<string | null> {
  const settings = useSettingsStore.getState();
  // A generated roster's explicit voice binding is the course voice source of truth.
  // Global settings remain the fallback for classrooms without a binding.
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const globalProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const boundVoice = teacher?.voiceConfig;
  const boundKey = boundVoice ? voiceBindingKey(boundVoice) : undefined;
  // The narrator pin makes boundVoice == the global voice. That equality must
  // not defeat the unavailable-binding fallbacks: when the pinned voice is
  // unusable (provider disabled, or the clone deleted server-side), fall back
  // to the deterministic enabled-provider pick with a single non-fatal notice
  // instead of throwing (QWEN_VC_VOICE_NOT_FOUND) or silently skipping.
  const globalDiffers =
    !!boundVoice &&
    (boundVoice.providerId !== settings.ttsProviderId || boundVoice.voiceId !== settings.ttsVoice);
  const fallbackForUnusablePin = (): ResolvedVoice | null => {
    if (!boundVoice) return null;
    const key = voiceBindingKey(boundVoice);
    markVoiceBindingUnavailable(boundVoice);
    if (markVoiceBindingNoticeShown(key)) {
      toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
    }
    return resolveDeterministicFallbackVoice(
      getEnabledProvidersWithVoices(settings.ttsProvidersConfig),
      0,
    );
  };

  let resolvedVoice =
    overrideVoice ??
    resolveNarratorVoiceBinding(
      boundVoice && isVoiceBindingUnavailable(boundVoice) ? undefined : boundVoice,
      {
        providerId: settings.ttsProviderId,
        modelId: globalProviderConfig?.modelId,
        voiceId: settings.ttsVoice,
      },
      settings.ttsProvidersConfig,
    );

  // Pinned narrator (bound == global) whose provider became disabled:
  // resolveNarratorVoiceBinding falls back to the global voice, which is the
  // same broken provider — swap in the deterministic enabled-provider pick
  // instead of silently skipping narration below.
  if (
    boundVoice &&
    !globalDiffers &&
    !isTTSProviderEnabled(
      resolvedVoice.providerId,
      settings.ttsProvidersConfig?.[resolvedVoice.providerId],
    )
  ) {
    resolvedVoice = fallbackForUnusablePin() ?? resolvedVoice;
  }

  const ttsProviderId = resolvedVoice.providerId;
  const ttsVoice = resolvedVoice.voiceId;
  const ttsProviderConfig = settings.ttsProvidersConfig?.[ttsProviderId];
  const ttsModelId = resolveTTSModelForVoice(
    ttsProviderId,
    ttsVoice,
    resolvedVoice.modelId ?? ttsProviderConfig?.modelId,
  );

  if (ttsProviderId === 'browser-native-tts') return null;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (!isTTSProviderEnabled(ttsProviderId, ttsProviderConfig)) return null;

  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: ttsProviderId,
    providerConfig: { ...ttsProviderConfig, modelId: ttsModelId },
    voiceId: ttsVoice,
    language,
  });
  let data: TTSApiResponse;
  try {
    data = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            audioId: requestId,
            ttsProviderId,
            ttsModelId,
            ttsVoice,
            ttsSpeed: settings.ttsSpeed,
            ttsApiKey: ttsProviderConfig?.apiKey || undefined,
            // Managed providers resolve their base URL server-side; only send the
            // client's own base URL (custom providers).
            ttsBaseUrl:
              ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
            ttsProviderOptions: providerOptions,
          }),
          signal,
        });

        const data = (await readJsonResponse(response)) as TTSApiResponse;
        if (!response.ok) {
          throw createHttpError(response, data, 'TTS request failed');
        }
        return data;
      },
      {
        label: `tts "${requestId}"`,
        shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'errorCode' in error
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    // Recover from a missing clone only when the attempt that just failed used
    // the bound binding itself: marking it unavailable makes the resolver fall
    // back to the global voice, a DIFFERENT voice. When the failure is already
    // on the global voice (or on the deterministic pick), retrying would hit
    // the same dead voice — fall through and surface the error instead of
    // hot-looping /api/generate/tts (bound-dead → global-dead → …). The
    // fallbackHops bound keeps even pathological chains at a single hop.
    if (
      errorCode === 'QWEN_VC_VOICE_NOT_FOUND' &&
      boundKey &&
      boundVoice &&
      fallbackHops < MAX_NARRATOR_VOICE_FALLBACK_HOPS
    ) {
      if (voiceBindingKey(resolvedVoice) === boundKey) {
        markVoiceBindingUnavailable(boundVoice);
        if (markVoiceBindingNoticeShown(boundKey)) {
          toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
        }
        if (globalDiffers) {
          // The binding is a voice distinct from the global one: retry with the
          // binding marked unavailable, which makes the resolver fall back to the
          // global voice.
          return generateAndStoreTTS(
            requestId,
            text,
            language,
            signal,
            retryOptions,
            existingAudioId,
            stageId,
            undefined,
            fallbackHops + 1,
          );
        }
        // Bound == global (pinned narrator): a retry would hit the same missing
        // clone, so fall back to the deterministic enabled-provider pick once.
        // (mark/notice were applied above; the helper's repeat is idempotent.)
        if (!overrideVoice) {
          const fallbackVoice = fallbackForUnusablePin();
          if (fallbackVoice) {
            return generateAndStoreTTS(
              requestId,
              text,
              language,
              signal,
              retryOptions,
              existingAudioId,
              stageId,
              fallbackVoice,
              fallbackHops + 1,
            );
          }
        }
      }
    }
    throw error;
  }
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', requestId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  const audioId = existingAudioId ?? requestId;
  await db.audioFiles.put({
    id: audioId,
    stageId,
    blob,
    duration,
    format: data.format,
    text,
    voice: ttsVoice,
    createdAt: Date.now(),
  });
  return audioId;
}

export async function removeFreshTtsAllocations(assetIds: readonly string[]): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    await db.audioFiles.delete(assetId).catch(() => undefined);
  }
}

function speechAllocationIds(scene: Scene): string[] {
  return (scene.actions ?? []).flatMap((action) =>
    action.type === 'speech' && action.audioId ? [action.audioId] : [],
  );
}

/** Generate TTS for all speech actions in a scene. Returns result. */
export async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = scene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return { success: true, failedCount: 0 };

  let failedCount = 0;
  let lastError: string | undefined;
  const freshAllocations: string[] = [];

  // Scene order keeps the provider request correlation label unique. Storage
  // identity is allocated by the pool and is never derived from this value.
  const sceneOrder = scene.order;

  // Generate + store one action's audio. Failures are counted, not thrown, so
  // one bad clip never aborts the rest of the scene.
  const generateOne = async (action: SpeechAction) => {
    const requestId = `tts_s${sceneOrder}_${action.id}`;
    try {
      const assetId = await generateAndStoreTTS(
        requestId,
        action.text,
        language,
        signal,
        retryOptions,
        undefined,
        scene.stageId,
      );
      if (assetId) {
        action.audioId = assetId;
        freshAllocations.push(assetId);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId,
        actionId: action.id,
        sceneOrder,
        requestId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  };

  // #660 follow-up: speech actions within a scene are independent — each renders
  // its own audio under its own audioId, with no cross-action ordering — so when
  // the server opts into parallel generation, render them with bounded
  // concurrency (reusing the PARALLEL_SCENE_CONCURRENCY knob) instead of one at a
  // time. Default (0 / unset) keeps the original strictly-serial behaviour.
  const ttsConcurrency = Math.max(
    0,
    Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
  );
  try {
    if (ttsConcurrency > 1 && speechActions.length > 1) {
      const settled = await Promise.allSettled(
        lazyBoundedMap(speechActions, ttsConcurrency, generateOne),
      );
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) throw rejected.reason;
    } else {
      for (const action of speechActions) {
        await generateOne(action);
      }
    }
  } catch (error) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
    throw error;
  }

  if (failedCount > 0) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
  }

  return {
    success: failedCount === 0,
    failedCount,
    error: lastError,
  };
}

export interface UseSceneGeneratorOptions {
  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: 'content' | 'actions', outline: SceneOutline) => void;
  onComplete?: () => void;
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const abortRef = useRef(false);
  const generatingRef = useRef(false);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastParamsRef = useRef<GenerationParams | null>(null);
  const generateRemainingRef = useRef<((params: GenerationParams) => Promise<void>) | null>(null);

  const store = useStageStore;

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      lastParamsRef.current = params;
      if (generatingRef.current) return;
      generatingRef.current = true;
      abortRef.current = false;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Create a new AbortController for this generation run
      fetchAbortRef.current = new AbortController();
      const signal = fetchAbortRef.current.signal;

      const state = store.getState();
      const { outlines, scenes, stage } = state;
      const startEpoch = state.generationEpoch;
      if (!stage || outlines.length === 0) {
        generatingRef.current = false;
        return;
      }

      store.getState().setGenerationStatus('generating');

      // Determine pending outlines
      const completedOrders = new Set(scenes.map((s) => s.order));
      const pending = outlines
        .filter((o) => !completedOrders.has(o.order))
        .sort((a, b) => a.order - b.order);

      if (pending.length === 0) {
        store.getState().setGenerationStatus('completed');
        store.getState().setGeneratingOutlines([]);
        store.getState().setGenerationComplete(true);
        options.onComplete?.();
        generatingRef.current = false;
        return;
      }

      store.getState().setGeneratingOutlines(pending);

      // Launch media generation in parallel — does not block content/action generation
      mediaAbortRef.current = new AbortController();
      generateMediaForOutlines(outlines, stage.id, mediaAbortRef.current.signal).catch((err) => {
        log.warn('Media generation error:', err);
      });

      // Get previousSpeeches from last completed scene
      let previousSpeeches: string[] = [];
      const sortedScenes = [...scenes].sort((a, b) => a.order - b.order);
      if (sortedScenes.length > 0) {
        const lastScene = sortedScenes[sortedScenes.length - 1];
        previousSpeeches = (lastScene.actions || [])
          .filter((a): a is SpeechAction => a.type === 'speech')
          .map((a) => a.text);
      }

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1)+TTS(1) (same as
      // serial) while later content fetches run hidden behind earlier scenes'
      // actions/TTS. Content has no cross-scene dependency, so running it ahead is
      // safe; actions + TTS stay strictly serial to preserve previousSpeeches
      // threading and the pause-on-failure UX. With parallelism off this is exactly
      // the original one-at-a-time loop.
      try {
        const fetchContent = (outline: SceneOutline) =>
          fetchSceneContent(
            {
              outline,
              allOutlines: outlines,
              stageId: stage.id,
              pdfImages: params.pdfImages,
              imageMapping: params.imageMapping,
              stageInfo: params.stageInfo,
              agents: params.agents,
              languageDirective: params.languageDirective,
            },
            signal,
          );

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: () =>
                    !abortRef.current && store.getState().generationEpoch === startEpoch,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        let pausedByFailureOrAbort = false;
        let hadContentFailure = false;
        for (const outline of pending) {
          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          store.getState().setCurrentGeneratingOrder(outline.order);

          // Step 1: content — await this outline's pre-warmed fetch (parallel),
          // which usually resolved while the previous scene's actions/TTS ran; or
          // fetch it now (serial).
          let contentResult: SceneContentResult;
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            contentResult = await fetchContent(outline);
          }

          if (!contentResult.success || !contentResult.content) {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            store.getState().addFailedOutline(outline);
            options.onSceneFailed?.(outline, contentResult.error || 'Content generation failed');
            if (contentPromises) {
              // Parallel: surface the failure but keep going with the other scenes
              // (their content is already in flight).
              hadContentFailure = true;
              removeGeneratingOutline(outline.id);
              continue;
            }
            // Serial: pause the batch (unchanged behaviour).
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          // Step 2: Generate actions + assemble scene
          options.onPhaseChange?.('actions', outline);
          const actionsResult = await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || outline,
              allOutlines: outlines,
              content: contentResult.content,
              stageId: stage.id,
              agents: params.agents,
              previousSpeeches,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
            },
            signal,
          );

          if (actionsResult.success && actionsResult.scene) {
            const scene = actionsResult.scene;
            const settings = useSettingsStore.getState();

            // TTS generation — failure means the whole scene fails
            if (
              settings.ttsEnabled &&
              settings.ttsProviderId !== 'browser-native-tts' &&
              isTTSProviderEnabled(
                settings.ttsProviderId,
                settings.ttsProvidersConfig?.[settings.ttsProviderId],
              )
            ) {
              const ttsResult = await generateTTSForScene(
                scene,
                params.languageDirective || params.stageInfo.language,
                signal,
              );
              if (!ttsResult.success) {
                if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
                  pausedByFailureOrAbort = true;
                  break;
                }
                store.getState().addFailedOutline(outline);
                options.onSceneFailed?.(outline, ttsResult.error || 'TTS generation failed');
                store.getState().setGenerationStatus('paused');
                pausedByFailureOrAbort = true;
                break;
              }
            }

            // Epoch changed — stage switched, discard this scene
            if (store.getState().generationEpoch !== startEpoch) {
              await removeFreshTtsAllocations(speechAllocationIds(scene));
              pausedByFailureOrAbort = true;
              break;
            }

            removeGeneratingOutline(outline.id);
            useStageStore.getState().addScene(scene);
            options.onSceneGenerated?.(scene, outline.order);
            previousSpeeches = actionsResult.previousSpeeches || [];
          } else {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            store.getState().addFailedOutline(outline);
            options.onSceneFailed?.(outline, actionsResult.error || 'Actions generation failed');
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
        }

        if (!abortRef.current && !pausedByFailureOrAbort) {
          if (hadContentFailure) {
            // Parallel content phase left some outlines failed but kept going;
            // surface them for retry instead of signalling a clean completion.
            store.getState().setGenerationStatus('paused');
          } else {
            store.getState().setGenerationStatus('completed');
            store.getState().setGeneratingOutlines([]);
            store.getState().setGenerationComplete(true);
            options.onComplete?.();
          }
        }
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          store.getState().setGenerationStatus('paused');
        } else {
          throw err;
        }
      } finally {
        generatingRef.current = false;
        fetchAbortRef.current = null;
      }
    },
    [options, store],
  );

  // Keep ref in sync so retrySingleOutline can call it
  generateRemainingRef.current = generateRemaining;

  const stop = useCallback(() => {
    abortRef.current = true;
    store.getState().bumpGenerationEpoch();
    fetchAbortRef.current?.abort();
    mediaAbortRef.current?.abort();
  }, [store]);

  const isGenerating = useCallback(() => generatingRef.current, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      const params = lastParamsRef.current;
      if (!outline || !state.stage || !params) return;
      const retryEpoch = state.generationEpoch;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      const removeGeneratingOutline = () => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Remove from failed list and mark as generating
      store.getState().retryFailedOutline(outlineId);
      store.getState().setGenerationStatus('generating');
      const currentGenerating = store.getState().generatingOutlines;
      if (!currentGenerating.some((o) => o.id === outline.id)) {
        store.getState().setGeneratingOutlines([...currentGenerating, outline]);
      }

      const abortController = new AbortController();
      const signal = abortController.signal;

      try {
        // Step 1: Content
        const contentResult = await fetchSceneContent(
          {
            outline,
            allOutlines: state.outlines,
            stageId: state.stage.id,
            pdfImages: params.pdfImages,
            imageMapping: params.imageMapping,
            stageInfo: params.stageInfo,
            agents: params.agents,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!contentResult.success || !contentResult.content) {
          store.getState().addFailedOutline(outline);
          return;
        }

        // Step 2: Actions
        const sortedScenes = [...store.getState().scenes].sort((a, b) => a.order - b.order);
        const lastScene = sortedScenes[sortedScenes.length - 1];
        const previousSpeeches = lastScene
          ? (lastScene.actions || [])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text)
          : [];

        const actionsResult = await fetchSceneActions(
          {
            outline: contentResult.effectiveOutline || outline,
            allOutlines: state.outlines,
            content: contentResult.content,
            stageId: state.stage.id,
            agents: params.agents,
            previousSpeeches,
            userProfile: params.userProfile,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!actionsResult.success || !actionsResult.scene) {
          store.getState().addFailedOutline(outline);
          return;
        }

        // Step 3: TTS
        const settings = useSettingsStore.getState();
        if (
          settings.ttsEnabled &&
          settings.ttsProviderId !== 'browser-native-tts' &&
          isTTSProviderEnabled(
            settings.ttsProviderId,
            settings.ttsProvidersConfig?.[settings.ttsProviderId],
          )
        ) {
          const ttsResult = await generateTTSForScene(
            actionsResult.scene,
            params.languageDirective || params.stageInfo.language,
            signal,
          );
          if (!ttsResult.success) {
            store.getState().addFailedOutline(outline);
            return;
          }
        }

        if (store.getState().generationEpoch !== retryEpoch) {
          await removeFreshTtsAllocations(speechAllocationIds(actionsResult.scene));
          return;
        }

        removeGeneratingOutline();
        useStageStore.getState().addScene(actionsResult.scene);

        // Resume remaining generation if there are pending outlines
        if (store.getState().generatingOutlines.length > 0 && lastParamsRef.current) {
          generateRemainingRef.current?.(lastParamsRef.current);
        } else {
          // This retry may have materialized the final outstanding slide. The
          // generateRemaining completion path is not reached on the retry flow,
          // so mark completion here too — otherwise a later delete would treat
          // the orphaned outline as pending and regenerate it.
          store.getState().markGenerationCompleteIfDone();
        }
      } catch (err) {
        if (!isAbortError(err)) {
          store.getState().addFailedOutline(outline);
        }
      }
    },
    [store],
  );

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}
