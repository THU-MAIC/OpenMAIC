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

export function useDiscussionTTS({ enabled, agents, onAudioStateChange }: DiscussionTTSOptions) {
  const { locale, t } = useI18n();
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const ttsVolume = useSettingsStore((s) => s.ttsVolume);
  const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
  // Global lecture voice — used as fallback for teacher agent
  const globalTtsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const globalTtsVoice = useSettingsStore((s) => s.ttsVoice);
  const agentVoiceOverrides = useSettingsStore((s) => s.agentVoiceOverrides);
  const { profiles: voiceProfiles } = useAllVoiceProfiles();

  const queueRef = useRef<QueueItem[]>([]);
  const isPlayingRef = useRef(false);
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

  const processQueue = useCallback(async () => {
    if (pausedRef.current) return; // Don't advance while paused
    if (isPlayingRef.current || queueRef.current.length === 0) return;
    if (!enabled || ttsMuted) {
      queueRef.current = [];
      return;
    }

    isPlayingRef.current = true;
    const item = queueRef.current.shift()!;

    // Browser TTS
    if (item.providerId === 'browser-native-tts') {
      currentProviderRef.current = item.providerId;
      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      browserSpeakRef.current(item.text, item.voiceId);
      return;
    }

    // Server TTS — use the item's provider, not the global one
    currentProviderRef.current = item.providerId;
    onAudioStateChangeRef.current?.(item.agentId, 'generating');
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const providerConfig = ttsProvidersConfig[item.providerId];
      const agent = item.agentId ? agents.find((a) => a.id === item.agentId) : undefined;
      const providerOptions = await resolveAgentVoiceOptions(agent, {
        providerId: item.providerId,
        providerConfig: { ...providerConfig, modelId: item.modelId || providerConfig?.modelId },
        voiceId: item.voiceId,
        language: locale,
      });
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

      const audioUrl = `data:audio/${data.format || 'mp3'};base64,${data.base64}`;
      const audio = new Audio(audioUrl);
      audio.playbackRate = playbackSpeed;
      audio.volume = ttsMuted ? 0 : ttsVolume;
      audioRef.current = audio;
      audio.addEventListener('ended', () => {
        audioRef.current = null;
        isPlayingRef.current = false;
        segmentDoneCounterRef.current++;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        if (!pausedRef.current) {
          queueMicrotask(() => processQueueRef.current());
        }
      });
      audio.addEventListener('error', () => {
        audioRef.current = null;
        isPlayingRef.current = false;
        segmentDoneCounterRef.current++;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        if (!pausedRef.current) {
          queueMicrotask(() => processQueueRef.current());
        }
      });

      // If paused during TTS generation, keep audio ready but don't play
      if (pausedRef.current) {
        onAudioStateChangeRef.current?.(item.agentId, 'playing');
        audio.pause();
        return;
      }

      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      await audio.play();
    } catch (err) {
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
      isPlayingRef.current = false;
      segmentDoneCounterRef.current++;
      onAudioStateChangeRef.current?.(item.agentId, 'idle');
      if (!pausedRef.current) {
        queueMicrotask(() => processQueueRef.current());
      }
    }
  }, [
    agents,
    enabled,
    locale,
    t,
    ttsMuted,
    ttsVolume,
    ttsProvidersConfig,
    ttsSpeed,
    playbackSpeed,
  ]);

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
      } else if (providerId !== 'browser-native-tts') {
        onAudioStateChangeRef.current?.(agentId, 'generating');
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
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
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
      audioRef.current.play();
    } else if (!isPlayingRef.current) {
      // Audio finished while paused — kick-start the queue
      processQueueRef.current();
    }
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
