'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useBrowserTTS } from '@/lib/hooks/use-browser-tts';
import { resolveAgentVoice, getAvailableProvidersWithVoices } from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { TTSProviderId } from '@/lib/audio/types';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';

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
  voiceId: string;
}

export function useDiscussionTTS({ enabled, agents, onAudioStateChange }: DiscussionTTSOptions) {
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);
  const ttsVolume = useSettingsStore((s) => s.ttsVolume);
  const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
  // Global lecture voice — used as fallback for teacher agent
  const globalTtsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const globalTtsVoice = useSettingsStore((s) => s.ttsVoice);

  const queueRef = useRef<QueueItem[]>([]);
  const isPlayingRef = useRef(false);
  const pausedRef = useRef(false);
  const segmentDoneCounterRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onAudioStateChangeRef = useRef(onAudioStateChange);
  onAudioStateChangeRef.current = onAudioStateChange;
  const processQueueRef = useRef<() => void>(() => {});

  const { speak: browserSpeak, cancel: browserCancel } = useBrowserTTS({
    rate: ttsSpeed,
    onEnd: () => {
      isPlayingRef.current = false;
      segmentDoneCounterRef.current++;
      onAudioStateChangeRef.current?.(null, 'idle');
      processQueueRef.current();
    },
  });
  const browserCancelRef = useRef(browserCancel);
  browserCancelRef.current = browserCancel;
  const browserSpeakRef = useRef(browserSpeak);
  browserSpeakRef.current = browserSpeak;

  // Build agent index map for deterministic voice resolution
  const agentIndexMap = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const map = new Map<string, number>();
    agents.forEach((agent, i) => map.set(agent.id, i));
    agentIndexMap.current = map;
  }, [agents]);

  const resolveVoiceForAgent = useCallback(
    (agentId: string | null): { providerId: TTSProviderId; voiceId: string } => {
      const providers = getAvailableProvidersWithVoices(ttsProvidersConfig);
      if (!agentId) {
        if (providers.length > 0) {
          return {
            providerId: providers[0].providerId,
            voiceId: providers[0].voices[0]?.id ?? 'default',
          };
        }
        return { providerId: 'browser-native-tts', voiceId: 'default' };
      }
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) {
        if (providers.length > 0) {
          return {
            providerId: providers[0].providerId,
            voiceId: providers[0].voices[0]?.id ?? 'default',
          };
        }
        return { providerId: 'browser-native-tts', voiceId: 'default' };
      }
      // Teacher: always use global lecture voice (single source of truth with settings)
      if (agent.role === 'teacher') {
        return { providerId: globalTtsProviderId, voiceId: globalTtsVoice };
      }
      const index = agentIndexMap.current.get(agentId) ?? 0;
      return resolveAgentVoice(agent, index, providers);
    },
    [agents, ttsProvidersConfig, globalTtsProviderId, globalTtsVoice],
  );

  const processQueue = useCallback(async () => {
    if (isPlayingRef.current || queueRef.current.length === 0) return;
    if (!enabled || ttsMuted) {
      queueRef.current = [];
      return;
    }

    isPlayingRef.current = true;
    const item = queueRef.current.shift()!;

    // Browser TTS
    if (item.providerId === 'browser-native-tts') {
      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      browserSpeakRef.current(item.text, item.voiceId);
      return;
    }

    // Server TTS — use the item's provider, not the global one
    onAudioStateChangeRef.current?.(item.agentId, 'generating');
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const providerConfig = ttsProvidersConfig[item.providerId];
      const res = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: item.text,
          audioId: item.partId,
          ttsProviderId: item.providerId,
          ttsVoice: item.voiceId,
          ttsSpeed: ttsSpeed,
          ttsApiKey: providerConfig?.apiKey,
          ttsBaseUrl: providerConfig?.serverBaseUrl || providerConfig?.baseUrl,
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`TTS API error: ${res.status}`);

      const data = await res.json();
      if (!data.base64) throw new Error('No audio in response');

      const audioUrl = `data:audio/${data.format || 'mp3'};base64,${data.base64}`;
      const audio = new Audio(audioUrl);
      audio.playbackRate = playbackSpeed;
      audio.volume = ttsMuted ? 0 : ttsVolume;
      audioRef.current = audio;
      audio.addEventListener('ended', () => {
        isPlayingRef.current = false;
        segmentDoneCounterRef.current++;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        queueMicrotask(() => processQueueRef.current());
      });
      audio.addEventListener('error', () => {
        isPlayingRef.current = false;
        segmentDoneCounterRef.current++;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        queueMicrotask(() => processQueueRef.current());
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
      if ((err as Error).name !== 'AbortError') {
        console.error('[DiscussionTTS] TTS generation failed:', err);
      }
      isPlayingRef.current = false;
      segmentDoneCounterRef.current++;
      onAudioStateChangeRef.current?.(item.agentId, 'idle');
      queueMicrotask(() => processQueueRef.current());
    }
  }, [enabled, ttsMuted, ttsVolume, ttsProvidersConfig, ttsSpeed, playbackSpeed]);

  processQueueRef.current = processQueue;

  const handleSegmentSealed = useCallback(
    (messageId: string, partId: string, fullText: string, agentId: string | null) => {
      if (!enabled || ttsMuted || !fullText.trim()) return;

      const { providerId, voiceId } = resolveVoiceForAgent(agentId);
      queueRef.current.push({ messageId, partId, text: fullText, agentId, providerId, voiceId });

      if (!isPlayingRef.current) {
        processQueueRef.current();
      } else if (providerId !== 'browser-native-tts') {
        onAudioStateChangeRef.current?.(agentId, 'generating');
      }
    },
    [enabled, ttsMuted, resolveVoiceForAgent],
  );

  const cleanup = useCallback(() => {
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
    pausedRef.current = false;
    segmentDoneCounterRef.current = 0;
    onAudioStateChangeRef.current?.(null, 'idle');
  }, []);

  const pause = useCallback(() => {
    pausedRef.current = true;
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    if (audioRef.current && audioRef.current.paused && audioRef.current.src) {
      audioRef.current.play().catch(() => {});
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
