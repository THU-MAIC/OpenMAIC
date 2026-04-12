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
import type { SceneContent, SlideContent } from '@/lib/types/stage';

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

/**
 * Resolves the effective `skipSlide` value.
 * When new media is requested but the existing slide has no media slot,
 * the slide must be regenerated even if skipSlide was requested.
 */
export function resolveSkipSlide(
  skipSlide: boolean,
  mediaType: 'none' | 'image' | 'video' | 'keep',
  hasExistingMediaSlot: boolean,
): boolean {
  if (!skipSlide) return false;
  if (mediaType === 'none' || mediaType === 'keep') return true;
  // New media requested — only skip if there is already a media element to replace
  return hasExistingMediaSlot;
}

// ── Types ──

export interface RegenerateParams {
  outline: SceneOutline;
  audioTextOverride: string;
  mediaType: 'none' | 'image' | 'video' | 'keep';
  mediaPrompt?: string;
  /** When true, skip TTS generation and preserve existing speech audio from the scene. */
  skipAudio?: boolean;
  /** When true, skip slide content + actions generation and preserve the existing slide. */
  skipSlide?: boolean;
  /** Theme to apply during content generation. Falls back to server-side stage default. */
  themeId?: string;
}

export type RegenerateProgress = 'idle' | 'content' | 'audio' | 'media' | 'done' | 'error';

export interface RegenerateResult {
  success: boolean;
  /** Human-readable error message from the failing step, if any */
  error?: string;
}

export interface UseSceneRegeneratorReturn {
  regenerate: (sceneId: string, params: RegenerateParams) => Promise<RegenerateResult>;
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

  const regenerate = useCallback(
    async (sceneId: string, params: RegenerateParams): Promise<RegenerateResult> => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const signal = ctrl.signal;

      setProgress('content');
      setErrorStep(undefined);

      const store = useStageStore;
      const stageId = store.getState().stage?.id;
      const allOutlines = store.getState().outlines;

      if (!stageId) {
        log.error('Cannot regenerate: no active stage');
        setProgress('error');
        setErrorStep('content');
        return { success: false, error: 'No active stage found' };
      }

      // Pre-step: capture existing data from the current scene before any update
      const existingSpeechActions: SpeechAction[] = [];
      type MediaElementInfo = { type: 'image' | 'video'; src: string };
      const existingMediaElements: MediaElementInfo[] = [];
      let oldSceneContent: SceneContent | null = null;
      let oldSceneActions: Action[] | null = null;

      if (params.skipAudio || params.mediaType === 'keep' || params.skipSlide) {
        const oldScene = store.getState().scenes.find((s) => s.id === sceneId);
        if (oldScene) {
          if (params.skipAudio) {
            for (const action of oldScene.actions ?? []) {
              if (action.type === 'speech') existingSpeechActions.push(action as SpeechAction);
            }
          }
          if ((params.mediaType === 'keep' || params.skipSlide) && oldScene.type === 'slide') {
            for (const el of (oldScene.content as SlideContent).canvas.elements) {
              if ((el.type === 'image' || el.type === 'video') && el.src) {
                existingMediaElements.push({ type: el.type, src: el.src });
              }
            }
          }
          if (params.skipSlide) {
            oldSceneContent = oldScene.content;
            oldSceneActions = [...(oldScene.actions ?? [])];
          }
        }
      }

      // Resolve effective skipSlide: if new media is requested but there's no existing slot,
      // we must regenerate the slide to create a placeholder element.
      const effectiveSkipSlide = resolveSkipSlide(
        params.skipSlide ?? false,
        params.mediaType,
        existingMediaElements.length > 0,
      );

      // Resolve the effective media type for the outline:
      // 'keep' → use the type of the first existing media element (or 'none' if none found)
      const resolvedMediaType: 'none' | 'image' | 'video' =
        params.mediaType === 'keep' ? (existingMediaElements[0]?.type ?? 'none') : params.mediaType;

      // Pre-step: set outline.mediaGenerations based on user's media selection
      const outline: SceneOutline = {
        ...params.outline,
        mediaGenerations: buildMediaGenerations(resolvedMediaType, params.mediaPrompt),
      };

      // ── Steps 1a + 1b: Generate slide content and actions (or use existing) ──
      let contentData: unknown;
      let newActions: Action[];
      let newContent: SceneContent;

      if (effectiveSkipSlide) {
        // Use the existing scene — no content or actions regeneration
        if (!oldSceneContent || !oldSceneActions) {
          log.error('Cannot skipSlide: existing scene content not captured');
          setProgress('error');
          setErrorStep('content');
          return { success: false, error: 'Existing scene not found' };
        }
        newContent = oldSceneContent;
        newActions = oldSceneActions;
      } else {
        // ── Step 1a: Generate slide content ──
        try {
          const contentRes = await fetch('/api/generate/scene-content-only', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify({ outline, stageId, themeId: params.themeId }),
            signal,
          });
          const json = await contentRes.json();
          if (!contentRes.ok || !json.success) {
            throw new Error(json.error || `HTTP ${contentRes.status}`);
          }
          contentData = json.data;
        } catch (err) {
          if (signal.aborted) return { success: false };
          log.error('Step 1 (content) failed:', err);
          setProgress('error');
          setErrorStep('content');
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }

        if (signal.aborted) return { success: false };

        // ── Step 1b: Generate scene actions ──
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
          if (!json.scene.content) {
            throw new Error('Missing scene content in actions response');
          }
          newActions = json.scene.actions ?? [];
          newContent = json.scene.content;
        } catch (err) {
          if (signal.aborted) return { success: false };
          log.error('Step 1 (actions) failed:', err);
          setProgress('error');
          setErrorStep('content');
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }

        if (signal.aborted) return { success: false };

        // When keeping existing media, inject old src values into new content elements
        if (
          params.mediaType === 'keep' &&
          existingMediaElements.length > 0 &&
          newContent.type === 'slide'
        ) {
          const slideContent = newContent as SlideContent;
          const updatedElements = slideContent.canvas.elements.map((el) => {
            if (el.type === 'image') {
              const old = existingMediaElements.find((e) => e.type === 'image');
              if (old) return { ...el, src: old.src };
            } else if (el.type === 'video') {
              const old = existingMediaElements.find((e) => e.type === 'video');
              if (old) return { ...el, src: old.src };
            }
            return el;
          });
          newContent = {
            ...slideContent,
            canvas: { ...slideContent.canvas, elements: updatedElements },
          };
        }

        // If new media will be generated, reset any stale gen_img_1/gen_vid_1 task now so the
        // component shows a skeleton immediately instead of flashing the previous regen's image.
        if (params.mediaType === 'image' || params.mediaType === 'video') {
          const staleId = params.mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
          useMediaGenerationStore.getState().resetTask(staleId);
        }

        // Immediately show new slide content (without audio yet)
        store
          .getState()
          .updateScene(sceneId, { title: outline.title, content: newContent, actions: newActions });
      }

      // ── Step 2: Audio ──
      if (params.skipAudio) {
        // Preserve existing audio — map old speech actions (text + audioId + audioUrl) onto
        // the new actions by index, so the narration stays unchanged without re-running TTS.
        let speechIdx = 0;
        const preservedActions = newActions.map((action) => {
          if (action.type === 'speech') {
            const old = existingSpeechActions[speechIdx++];
            if (old) {
              return {
                ...action,
                text: old.text,
                ...(old.audioId ? { audioId: old.audioId } : {}),
                ...(old.audioUrl ? { audioUrl: old.audioUrl } : {}),
              } as SpeechAction;
            }
          }
          return action;
        });
        store.getState().updateScene(sceneId, { actions: preservedActions });
      } else {
        setProgress('audio');

        // Apply user audio override text to speech actions
        const overriddenActions = params.audioTextOverride
          ? applyAudioOverride(newActions, params.audioTextOverride)
          : newActions;

        // Split long speech actions per provider limits
        const ttsProviderId = useSettingsStore.getState().ttsProviderId;
        const speechActions = splitLongSpeechActions(overriddenActions, ttsProviderId);

        // Commit overridden text to store immediately (before TTS — so text is always saved even if TTS fails)
        store.getState().updateScene(sceneId, { actions: [...speechActions] });

        const { ttsEnabled } = useUserPrefsStore.getState();
        if (ttsEnabled && ttsProviderId !== 'browser-native-tts') {
          for (let i = 0; i < speechActions.length; i++) {
            if (signal.aborted) return { success: false };
            const action = speechActions[i];
            if (action.type !== 'speech') continue;
            // TypeScript doesn't narrow Action to SpeechAction via type guard in this context
            const speechAction = action as SpeechAction;
            if (!speechAction.text) continue;
            const audioId = `tts_${speechAction.id}`;
            let audioUrl: string | undefined;
            try {
              audioUrl =
                (await generateAndStoreTTS(audioId, speechAction.text, signal)) ?? undefined;
            } catch (err) {
              if (signal.aborted) return { success: false };
              log.warn('TTS failed for action', speechAction.id, ':', err);
            }
            speechActions[i] = {
              ...speechAction,
              audioId,
              ...(audioUrl ? { audioUrl } : {}),
            } as SpeechAction;
            // Update scene progressively as each TTS clip is ready
            store.getState().updateScene(sceneId, { actions: [...speechActions] });
          }
        }
      }

      // ── Step 3: Media ──
      if (params.mediaType !== 'none' && params.mediaType !== 'keep') {
        if (signal.aborted) return { success: false };
        setProgress('media');
        const elementId = params.mediaType === 'image' ? 'gen_img_1' : 'gen_vid_1';
        const req: MediaGenerationRequest = {
          elementId,
          type: params.mediaType,
          prompt: params.mediaPrompt ?? '',
        };
        // Reset any stale task so enqueueTasks creates a fresh pending entry.
        // Required for skipSlide=false: if a previous regen already stored gen_img_1,
        // enqueueTasks would skip it and the new slide would flash the old image.
        useMediaGenerationStore.getState().resetTask(elementId);
        useMediaGenerationStore.getState().enqueueTasks(stageId, [req]);
        try {
          await generateAndStoreMedia(req, stageId, signal);
        } catch (err) {
          if (signal.aborted) return { success: false };
          log.warn('Media generation failed:', err);
        }

        // Patch the canvas element src to the real server URL.
        // This fixes two issues:
        // 1. skipSlide=true: existing element has a real src (not a placeholder) so SlideRenderer
        //    never consults the media store — direct canvas patch is required.
        // 2. skipSlide=false: leaving src='gen_img_1' permanently causes cross-slide contamination
        //    because all regens share the same placeholder key.
        if (!signal.aborted && newContent.type === 'slide') {
          const newMediaUrl = useMediaGenerationStore.getState().tasks[elementId]?.objectUrl;
          if (newMediaUrl) {
            // Append cache-busting timestamp so the browser fetches the newly generated
            // image/video instead of serving the previous cached response for the same URL.
            const cacheBustedUrl = `${newMediaUrl}?t=${Date.now()}`;
            const slideContent = newContent as SlideContent;
            const mediaElType = params.mediaType as 'image' | 'video';
            const patchedElements = slideContent.canvas.elements.map((el) =>
              el.type === mediaElType ? { ...el, src: cacheBustedUrl } : el,
            );
            newContent = {
              ...slideContent,
              canvas: { ...slideContent.canvas, elements: patchedElements },
            };
            store.getState().updateScene(sceneId, { content: newContent });
          }
        }
      }

      if (signal.aborted) return { success: false };

      // ── Step 4: Outline sync ──
      const freshOutlines = store.getState().outlines;
      const updatedOutlines = freshOutlines.map((o) => (o.order === outline.order ? outline : o));
      store.getState().setOutlines(updatedOutlines);

      setProgress('done');
      return { success: true };
    },
    [],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setProgress('idle');
    setErrorStep(undefined);
  }, []);

  return { regenerate, progress, errorStep, cancel };
}
