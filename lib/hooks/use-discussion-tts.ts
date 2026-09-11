'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useBrowserTTS } from '@/lib/hooks/use-browser-tts';
import {
  resolveAgentVoice,
  resolveNarratorVoiceBinding,
  getSelectableProvidersWithVoices,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { useAllVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { resolveAgentVoiceOptions } from '@/lib/audio/agent-voice';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { TTSProviderId } from '@/lib/audio/types';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isQwenCloneVoice, resolveTTSModelForVoice } from '@/lib/audio/constants';
import { toast } from 'sonner';
import {
  isVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  markVoiceBindingUnavailable,
  trackAssignedVoiceBinding,
} from '@/lib/audio/unavailable-voice-bindings';

interface DiscussionTTSOptions {
  enabled: boolean;
  agents: AgentConfig[];
  onAudioStateChange?: (agentId: string | null, state: AudioIndicatorState) => void;
}

interface QueueItem {
  messageId: string;
  partId: string;
  text: string;
  agentId: string | null;
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
  fallbackVoice?: ResolvedVoice;
}

interface PreparedSegment {
  item: QueueItem;
  controller: AbortController;
  // A prefetched failure is handled when its segment reaches the playback head.
  result: Promise<{ audioUrl: string } | { error: unknown }>;
}

export function useDiscussionTTS({ enabled, agents, onAudioStateChange }: DiscussionTTSOptions) {
  const { locale, t } = useI18n();
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const ttsVolume = useSettingsStore((s) => s.ttsVolume);
  const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
  const playbackSettingsRef = useRef({ playbackSpeed, ttsMuted, ttsVolume });
  playbackSettingsRef.current = { playbackSpeed, ttsMuted, ttsVolume };
  // Global lecture voice — used as fallback for teacher agent
  const globalTtsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const globalTtsVoice = useSettingsStore((s) => s.ttsVoice);
  const agentVoiceOverrides = useSettingsStore((s) => s.agentVoiceOverrides);
  const { profiles: voiceProfiles } = useAllVoiceProfiles();

  const queueRef = useRef<QueueItem[]>([]);
  const isPlayingRef = useRef(false);
  const currentItemRef = useRef<QueueItem | null>(null);
  const prefetchedRef = useRef<PreparedSegment | null>(null);
  const prefetchNextRef = useRef<() => void>(() => {});
  const finishAudioRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(false);
  /** Tracks which TTS provider is currently speaking (for pause/resume delegation) */
  const currentProviderRef = useRef<TTSProviderId | null>(null);
  const segmentDoneCounterRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onAudioStateChangeRef = useRef(onAudioStateChange);
  onAudioStateChangeRef.current = onAudioStateChange;
  const processQueueRef = useRef<() => void>(() => {});
  const agentBindingKeysRef = useRef(new Map<string, string>());

  const {
    speak: browserSpeak,
    pause: browserPause,
    resume: browserResume,
    cancel: browserCancel,
  } = useBrowserTTS({
    rate: ttsSpeed,
    onEnd: () => {
      if (currentProviderRef.current !== 'browser-native-tts' || !isPlayingRef.current) return;
      currentItemRef.current = null;
      currentProviderRef.current = null;
      isPlayingRef.current = false;
      segmentDoneCounterRef.current++;
      onAudioStateChangeRef.current?.(null, 'idle');
      // Don't advance queue while paused — resume() will kick-start it
      if (!pausedRef.current) {
        processQueueRef.current();
      }
    },
  });
  const browserCancelRef = useRef(browserCancel);
  browserCancelRef.current = browserCancel;
  const browserSpeakRef = useRef(browserSpeak);
  browserSpeakRef.current = browserSpeak;
  const browserPauseRef = useRef(browserPause);
  browserPauseRef.current = browserPause;
  const browserResumeRef = useRef(browserResume);
  browserResumeRef.current = browserResume;

  // Build agent index map for deterministic voice resolution
  const agentIndexMap = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const map = new Map<string, number>();
    agents.forEach((agent, i) => map.set(agent.id, i));
    agentIndexMap.current = map;
  }, [agents]);

  // Browser-native voices (dynamic, client-only) — same source the AgentBar
  // picker uses, so discussion resolution and the picker stay in sync.
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const load = () => setBrowserVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  const resolveVoiceForAgent = useCallback(
    (agentId: string | null): ResolvedVoice | null => {
      // ONE selectable-provider list shared with the AgentBar picker: enabled
      // server/custom providers + opt-in browser-native. Students resolve against
      // it (fixes the #665 student-silence bug); the teacher uses the global
      // lecture voice (below).
      const providers = getSelectableProvidersWithVoices(
        ttsProvidersConfig,
        voiceProfiles,
        browserVoices,
      );
      const firstVoice = (): ResolvedVoice | null =>
        providers.length > 0
          ? {
              providerId: providers[0].providerId,
              voiceId: providers[0].voices[0]?.id ?? 'default',
            }
          : null;

      const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
      if (!agent) return firstVoice();

      const globalVoice = resolveNarratorVoiceBinding(
        undefined,
        {
          providerId: globalTtsProviderId,
          voiceId: globalTtsVoice,
          modelId: ttsProvidersConfig[globalTtsProviderId]?.modelId,
        },
        ttsProvidersConfig,
      );
      // Teacher's voice = the global lecture selection, honored VERBATIM (incl.
      // its model) whenever that provider is enabled — identical to what the
      // pre-generated lecture sends (use-scene-generator), so lecture and
      // discussion teacher never diverge. No voiceId re-validation/fallback that
      // could swap the user's chosen voice. Only if the global provider is itself
      // disabled does the teacher fall back to an enabled provider.
      if (agent.role === 'teacher') {
        const resolved = resolveNarratorVoiceBinding(
          agent.voiceConfig,
          {
            providerId: globalTtsProviderId,
            voiceId: globalTtsVoice,
            modelId: ttsProvidersConfig[globalTtsProviderId]?.modelId,
          },
          ttsProvidersConfig,
        );
        const preferred = isTTSProviderEnabled(
          resolved.providerId,
          ttsProvidersConfig[resolved.providerId],
        )
          ? resolved
          : firstVoice();
        return applyUnavailableBindingFallback(agent.id, preferred, globalVoice, firstVoice);
      }

      const index = agentIndexMap.current.get(agentId!) ?? 0;
      return applyUnavailableBindingFallback(
        agent.id,
        resolveAgentVoice(agent, index, providers, agentVoiceOverrides),
        globalVoice,
        firstVoice,
      );

      function applyUnavailableBindingFallback(
        id: string,
        preferred: ResolvedVoice | null,
        fallback: ResolvedVoice,
        getFirstVoice: () => ResolvedVoice | null,
      ): ResolvedVoice | null {
        if (!preferred) return null;
        const previousKey = agentBindingKeysRef.current.get(id);
        const key = trackAssignedVoiceBinding(previousKey, preferred);
        agentBindingKeysRef.current.set(id, key);
        if (!isVoiceBindingUnavailable(preferred)) return preferred;
        return isTTSProviderEnabled(fallback.providerId, ttsProvidersConfig[fallback.providerId])
          ? fallback
          : getFirstVoice();
      }
    },
    [
      agents,
      ttsProvidersConfig,
      voiceProfiles,
      browserVoices,
      globalTtsProviderId,
      globalTtsVoice,
      agentVoiceOverrides,
    ],
  );

  const generateAudio = useCallback(
    async (item: QueueItem, controller: AbortController): Promise<string> => {
      const providerConfig = ttsProvidersConfig[item.providerId];
      const agent = item.agentId ? agents.find((a) => a.id === item.agentId) : undefined;
      const providerOptions = await resolveAgentVoiceOptions(agent, {
        providerId: item.providerId,
        providerConfig: { ...providerConfig, modelId: item.modelId || providerConfig?.modelId },
        voiceId: item.voiceId,
        language: locale,
      });
      controller.signal.throwIfAborted();
      const res = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: item.text,
          audioId: item.partId,
          ttsProviderId: item.providerId,
          ttsModelId: item.modelId || providerConfig?.modelId,
          ttsVoice: item.voiceId,
          ttsSpeed: ttsSpeed,
          ttsApiKey: providerConfig?.apiKey,
          // Managed providers resolve their base URL server-side; only send the
          // client's own base URL (custom providers).
          ttsBaseUrl: providerConfig?.baseUrl || providerConfig?.customDefaultBaseUrl,
          ttsProviderOptions: providerOptions,
        }),
        signal: controller.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        const error = new Error(
          typeof data.error === 'string' ? data.error : `TTS API error: ${res.status}`,
        ) as Error & { errorCode?: string };
        if (typeof data.errorCode === 'string') error.errorCode = data.errorCode;
        throw error;
      }
      if (!data.base64) throw new Error('No audio in response');

      controller.signal.throwIfAborted();
      return `data:audio/${data.format || 'mp3'};base64,${data.base64}`;
    },
    [agents, locale, ttsProvidersConfig, ttsSpeed],
  );

  const prefetchNext = useCallback(() => {
    // One active synthesis at a time, with at most one prepared segment ahead
    // of playback. Browser speech stays on the sequential playback path.
    if (!enabled || ttsMuted || pausedRef.current || !isPlayingRef.current) return;
    if (abortControllerRef.current || prefetchedRef.current) return;
    const item = queueRef.current[0];
    if (!item || item.providerId === 'browser-native-tts') return;
    const controller = new AbortController();
    prefetchedRef.current = {
      item,
      controller,
      result: generateAudio(item, controller).then(
        (audioUrl) => ({ audioUrl }),
        (error: unknown) => ({ error }),
      ),
    };
  }, [enabled, ttsMuted, generateAudio]);
  prefetchNextRef.current = prefetchNext;

  const processQueue = useCallback(async () => {
    if (pausedRef.current) return; // Don't advance while paused
    if (isPlayingRef.current || queueRef.current.length === 0) return;
    if (!enabled || ttsMuted) {
      queueRef.current = [];
      return;
    }

    isPlayingRef.current = true;
    const item = queueRef.current.shift()!;
    currentItemRef.current = item;

    // Browser TTS
    if (item.providerId === 'browser-native-tts') {
      currentProviderRef.current = item.providerId;
      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      browserSpeakRef.current(item.text, item.voiceId);
      prefetchNextRef.current();
      return;
    }

    // Server TTS — use the item's provider, not the global one
    currentProviderRef.current = item.providerId;
    onAudioStateChangeRef.current?.(item.agentId, 'generating');
    const prefetched = prefetchedRef.current;
    const controller = prefetched?.item === item ? prefetched.controller : new AbortController();
    if (prefetched?.item === item) prefetchedRef.current = null;
    abortControllerRef.current = controller;

    try {
      const result =
        prefetched?.item === item
          ? await prefetched.result
          : await generateAudio(item, controller).then(
              (audioUrl) => ({ audioUrl }),
              (error: unknown) => ({ error }),
            );
      if (controller.signal.aborted || currentItemRef.current !== item) return;
      if ('error' in result) throw result.error;
      abortControllerRef.current = null;
      const audioUrl = result.audioUrl;
      const audio = new Audio(audioUrl);
      const settings = playbackSettingsRef.current;
      audio.playbackRate = settings.playbackSpeed;
      audio.volume = settings.ttsMuted ? 0 : settings.ttsVolume;
      audioRef.current = audio;
      const finish = () => {
        if (audioRef.current !== audio) return;
        audioRef.current = null;
        finishAudioRef.current = null;
        currentItemRef.current = null;
        currentProviderRef.current = null;
        audio.removeEventListener('ended', finish);
        audio.removeEventListener('error', finish);
        audio.pause();
        audio.src = '';
        isPlayingRef.current = false;
        segmentDoneCounterRef.current++;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        if (!pausedRef.current) {
          queueMicrotask(() => processQueueRef.current());
        }
      };
      finishAudioRef.current = finish;
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);

      // If paused during TTS generation, keep audio ready but don't play
      if (pausedRef.current) {
        onAudioStateChangeRef.current?.(item.agentId, 'playing');
        audio.pause();
        return;
      }

      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      await audio.play();
      if (audioRef.current === audio) prefetchNextRef.current();
    } catch (err) {
      if (controller.signal.aborted || currentItemRef.current !== item) return;
      if (finishAudioRef.current) {
        finishAudioRef.current();
        return;
      }
      abortControllerRef.current = null;
      const cloneUnavailable =
        err &&
        typeof err === 'object' &&
        (err as { errorCode?: unknown }).errorCode === 'QWEN_VC_VOICE_NOT_FOUND' &&
        item.agentId &&
        item.fallbackVoice;
      if (cloneUnavailable) {
        const unavailableKey = markVoiceBindingUnavailable({
          providerId: item.providerId,
          voiceId: item.voiceId,
        });
        if (markVoiceBindingNoticeShown(unavailableKey)) {
          toast.warning(t('settings.qwenCloneDiscussionUnavailable'));
        }
        queueRef.current.unshift({
          ...item,
          providerId: item.fallbackVoice!.providerId,
          modelId: item.fallbackVoice!.modelId,
          voiceId: item.fallbackVoice!.voiceId,
          fallbackVoice: undefined,
        });
      }
      if ((err as Error).name !== 'AbortError') {
        console.error('[DiscussionTTS] TTS generation failed:', err);
      }
      audioRef.current = null;
      currentItemRef.current = null;
      currentProviderRef.current = null;
      isPlayingRef.current = false;
      // Retrying a missing clone is still the same speech segment.
      if (!cloneUnavailable) segmentDoneCounterRef.current++;
      onAudioStateChangeRef.current?.(item.agentId, 'idle');
      if (!pausedRef.current) {
        queueMicrotask(() => processQueueRef.current());
      }
    }
  }, [enabled, t, ttsMuted, generateAudio]);

  processQueueRef.current = processQueue;

  const handleSegmentSealed = useCallback(
    (messageId: string, partId: string, fullText: string, agentId: string | null) => {
      if (!enabled || ttsMuted || !fullText.trim()) return;

      // No enabled provider for this agent ⇒ skip TTS (no silent browser-native).
      const resolved = resolveVoiceForAgent(agentId);
      if (!resolved) return;
      const { providerId, modelId, voiceId } = resolved;
      const effectiveModelId = resolveTTSModelForVoice(
        providerId,
        voiceId,
        modelId ?? ttsProvidersConfig[providerId]?.modelId,
      );
      const fallbackVoice =
        agentId && providerId === 'qwen-tts' && isQwenCloneVoice(voiceId)
          ? resolveNarratorVoiceBinding(
              undefined,
              {
                providerId: globalTtsProviderId,
                voiceId: globalTtsVoice,
                modelId: ttsProvidersConfig[globalTtsProviderId]?.modelId,
              },
              ttsProvidersConfig,
            )
          : undefined;
      queueRef.current.push({
        messageId,
        partId,
        text: fullText,
        agentId,
        providerId,
        modelId: effectiveModelId,
        voiceId,
        ...(fallbackVoice &&
        (fallbackVoice.providerId !== providerId || fallbackVoice.voiceId !== voiceId)
          ? { fallbackVoice }
          : {}),
      });

      if (!isPlayingRef.current) {
        processQueueRef.current();
      } else {
        prefetchNextRef.current();
      }
    },
    [
      enabled,
      globalTtsProviderId,
      globalTtsVoice,
      resolveVoiceForAgent,
      ttsMuted,
      ttsProvidersConfig,
    ],
  );

  const cleanup = useCallback(() => {
    pausedRef.current = false;
    currentProviderRef.current = null;
    currentItemRef.current = null;
    finishAudioRef.current = null;
    prefetchedRef.current?.controller.abort();
    prefetchedRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (audioRef.current) {
      const audio = audioRef.current;
      audioRef.current = null;
      audio.pause();
      audio.src = '';
    }
    browserCancelRef.current();
    queueRef.current = [];
    isPlayingRef.current = false;
    segmentDoneCounterRef.current = 0;
    onAudioStateChangeRef.current?.(null, 'idle');
  }, []);

  /** Pause TTS audio (browser-native or server). Does NOT stop the SSE stream. */
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    if (currentProviderRef.current === 'browser-native-tts') {
      browserPauseRef.current();
    } else if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, []);

  /** Resume TTS audio. If the previous utterance already ended while paused, advance the queue. */
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    if (currentProviderRef.current === 'browser-native-tts') {
      browserResumeRef.current();
    } else if (audioRef.current && audioRef.current.paused) {
      const audio = audioRef.current;
      void audio.play().catch(() => {
        if (audioRef.current === audio) finishAudioRef.current?.();
      });
    } else if (!isPlayingRef.current) {
      // Audio finished while paused — kick-start the queue
      processQueueRef.current();
    }
    prefetchNextRef.current();
  }, []);

  // Sync playbackSpeed to currently playing audio in real-time
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  // Sync volume and mute to currently playing audio in real-time
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = ttsMuted ? 0 : ttsVolume;
    }
  }, [ttsVolume, ttsMuted]);

  // Muting keeps the current clip's position (the volume effect silences it).
  // PlaybackChromeRoot also sets enabled=false while muted, so distinguish
  // that from turning TTS off. Only speculative work is cancelled on mute.
  useEffect(() => {
    if (ttsMuted) {
      prefetchedRef.current?.controller.abort();
      prefetchedRef.current = null;
    } else if (!enabled) {
      cleanup();
    } else {
      prefetchNextRef.current();
    }
  }, [enabled, ttsMuted, cleanup]);

  useEffect(() => cleanup, [cleanup]);

  /**
   * Returns true when TTS audio for the *current* segment is still playing.
   * Uses a monotonic counter so the buffer releases as soon as one segment's
   * audio finishes, even if the next segment starts immediately.
   */
  const shouldHold = useCallback(() => {
    return {
      holding: isPlayingRef.current || queueRef.current.length > 0,
      segmentDone: segmentDoneCounterRef.current,
    };
  }, []);

  return {
    handleSegmentSealed,
    cleanup,
    pause,
    resume,
    shouldHold,
  };
}
