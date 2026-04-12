'use client';

import { useRef, useState, useCallback } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserPrefsStore } from '@/lib/store/user-prefs';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { generateAndStoreMedia } from '@/lib/media/media-orchestrator';
import { generateAndStoreTTS } from '@/lib/audio/generate-and-store-tts';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { createLogger } from '@/lib/logger';
import type { SceneOutline } from '@/lib/types/generation';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { MediaGenerationRequest } from '@/lib/media/types';
import type { SceneContent } from '@/lib/types/stage';

const log = createLogger('SceneRegenerator');

// ── Pure helpers (also used by RegenerateSlideDialog) ──

export function outlineToIndication(description: string, keyPoints: string[]): string {
  const bulletLines = keyPoints.map((k) => `• ${k}`).join('\n');
  return keyPoints.length > 0 ? `${description}\n${bulletLines}` : description;
}

export function indicationToOutline(indication: string): {
  description: string;
  keyPoints: string[];
} {
  const lines = indication.split('\n');
  const keyPoints: string[] = [];
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('• ')) {
      keyPoints.push(line.slice(2).trim());
    } else {
      descLines.push(line);
    }
  }
  return { description: descLines.join('\n').trim(), keyPoints };
}

export function buildMediaGenerations(
  mediaType: 'none' | 'image' | 'video',
  mediaPrompt?: string,
): MediaGenerationRequest[] {
  if (mediaType === 'none') return [];
  const elementId = mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
  return [{ elementId, type: mediaType, prompt: mediaPrompt ?? '' }];
}

export function applyAudioOverride(actions: Action[], audioOverride: string): Action[] {
  const segments = audioOverride
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let segIdx = 0;
  return actions.map((a) => {
    if (a.type === 'speech' && segIdx < segments.length) {
      return { ...a, text: segments[segIdx++] } as SpeechAction;
    }
    return a;
  });
}

// ── Types ──

export interface RegenerateParams {
  outline: SceneOutline;
  audioTextOverride: string;
  mediaType: 'none' | 'image' | 'video';
  mediaPrompt?: string;
}

export type RegenerateProgress = 'idle' | 'content' | 'audio' | 'media' | 'done' | 'error';

export interface UseSceneRegeneratorReturn {
  regenerate: (sceneId: string, params: RegenerateParams) => Promise<void>;
  progress: RegenerateProgress;
  errorStep?: 'content' | 'audio' | 'media';
  cancel: () => void;
}

// ── Internal: build model headers for generation API calls ──

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    // Media generation toggles
    'x-image-generation-enabled': String(
      useUserPrefsStore.getState().imageGenerationEnabled ?? false,
    ),
    'x-video-generation-enabled': String(
      useUserPrefsStore.getState().videoGenerationEnabled ?? false,
    ),
  };
}

// ── Hook ──

export function useSceneRegenerator(): UseSceneRegeneratorReturn {
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<RegenerateProgress>('idle');
  const [errorStep, setErrorStep] = useState<'content' | 'audio' | 'media' | undefined>();

  const regenerate = useCallback(async (sceneId: string, params: RegenerateParams) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    setProgress('content');
    setErrorStep(undefined);

    const store = useStageStore.getState();
    const stageId = store.stage?.id;
    const allOutlines = store.outlines;

    if (!stageId) {
      log.error('Cannot regenerate: no active stage');
      setProgress('error');
      setErrorStep('content');
      return;
    }

    // Pre-step: set outline.mediaGenerations based on user's media selection
    const outline: SceneOutline = {
      ...params.outline,
      mediaGenerations: buildMediaGenerations(params.mediaType, params.mediaPrompt),
    };

    // ── Step 1a: Generate slide content ──
    let contentData: unknown;
    try {
      const contentRes = await fetch('/api/generate/scene-content-only', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({ outline, stageId }),
        signal,
      });
      const json = await contentRes.json();
      if (!contentRes.ok || !json.success) {
        throw new Error(json.error || `HTTP ${contentRes.status}`);
      }
      contentData = json.data;
    } catch (err) {
      if (signal.aborted) return;
      log.error('Step 1 (content) failed:', err);
      setProgress('error');
      setErrorStep('content');
      return;
    }

    if (signal.aborted) return;

    // ── Step 1b: Generate scene actions ──
    let newActions: Action[];
    let newContent: SceneContent;
    try {
      const actionsRes = await fetch('/api/generate/scene-actions', {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          outline,
          allOutlines,
          content: contentData,
          stageId,
        }),
        signal,
      });
      const json = await actionsRes.json();
      if (!actionsRes.ok || !json.success || !json.scene) {
        throw new Error(json.error || `HTTP ${actionsRes.status}`);
      }
      newActions = json.scene.actions ?? [];
      newContent = json.scene.content;
    } catch (err) {
      if (signal.aborted) return;
      log.error('Step 1 (actions) failed:', err);
      setProgress('error');
      setErrorStep('content');
      return;
    }

    if (signal.aborted) return;

    // Immediately show new slide content (without audio yet)
    store.updateScene(sceneId, { content: newContent, actions: newActions });

    // ── Step 2: Audio ──
    setProgress('audio');

    // Apply user audio override text to speech actions
    const overriddenActions = params.audioTextOverride
      ? applyAudioOverride(newActions, params.audioTextOverride)
      : newActions;

    // Split long speech actions per provider limits
    const ttsProviderId = useSettingsStore.getState().ttsProviderId;
    const speechActions = splitLongSpeechActions(overriddenActions, ttsProviderId);

    // Commit overridden text to store immediately (before TTS — so text is always saved even if TTS fails)
    store.updateScene(sceneId, { actions: [...speechActions] });

    for (const action of speechActions) {
      if (signal.aborted) return;
      if (action.type !== 'speech') continue;
      const speechAction = action as SpeechAction;
      if (!speechAction.text) continue;
      const audioId = `tts_${speechAction.id}`;
      speechAction.audioId = audioId;
      try {
        const audioUrl = await generateAndStoreTTS(audioId, speechAction.text, signal);
        if (audioUrl) speechAction.audioUrl = audioUrl;
      } catch (err) {
        if (signal.aborted) return;
        log.warn('TTS failed for action', speechAction.id, ':', err);
      }
      // Update scene progressively as each TTS clip is ready
      store.updateScene(sceneId, { actions: [...speechActions] });
    }

    // ── Step 3: Media ──
    if (params.mediaType !== 'none') {
      if (signal.aborted) return;
      setProgress('media');
      const elementId = params.mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
      const req: MediaGenerationRequest = {
        elementId,
        type: params.mediaType,
        prompt: params.mediaPrompt ?? '',
      };
      useMediaGenerationStore.getState().enqueueTasks(stageId, [req]);
      try {
        await generateAndStoreMedia(req, stageId, signal);
      } catch (err) {
        if (signal.aborted) return;
        log.warn('Media generation failed:', err);
      }
    }

    if (signal.aborted) return;

    // ── Step 4: Outline sync ──
    const updatedOutlines = allOutlines.map((o) => (o.order === outline.order ? outline : o));
    store.setOutlines(updatedOutlines);

    setProgress('done');
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setProgress('idle');
    setErrorStep(undefined);
  }, []);

  return { regenerate, progress, errorStep, cancel };
}
