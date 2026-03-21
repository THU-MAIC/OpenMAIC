'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useBrowserTTS } from '@/lib/hooks/use-browser-tts';
import { resolveVoice, getServerVoiceList } from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
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
  voiceId: string;
}

export function useDiscussionTTS({ enabled, agents, onAudioStateChange }: DiscussionTTSOptions) {
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);

  const queueRef = useRef<QueueItem[]>([]);
  const isPlayingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Use refs to avoid stale closures in callbacks
  const onAudioStateChangeRef = useRef(onAudioStateChange);
  onAudioStateChangeRef.current = onAudioStateChange;
  const processQueueRef = useRef<() => void>(() => {});

  const isBrowserTTS = ttsProviderId === 'browser-native-tts';

  const {
    speak: browserSpeak,
    cancel: browserCancel,
    availableVoices: browserAvailableVoices,
  } = useBrowserTTS({
    rate: ttsSpeed,
    onEnd: () => {
      isPlayingRef.current = false;
      onAudioStateChangeRef.current?.(null, 'idle');
      processQueueRef.current();
    },
  });
  const browserCancelRef = useRef(browserCancel);
  browserCancelRef.current = browserCancel;

  // Build agent index map for deterministic voice resolution
  const agentIndexMap = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const map = new Map<string, number>();
    agents.forEach((agent, i) => map.set(agent.id, i));
    agentIndexMap.current = map;
  }, [agents]);

  const getVoiceForAgent = useCallback(
    (agentId: string | null): string => {
      if (!agentId) return 'default';
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) return 'default';
      const index = agentIndexMap.current.get(agentId) ?? 0;

      if (isBrowserTTS) {
        const browserVoices = browserAvailableVoices.map((v) => v.voiceURI);
        return resolveVoice(agent, ttsProviderId, index, browserVoices);
      }

      const serverVoices = getServerVoiceList(ttsProviderId);
      return resolveVoice(agent, ttsProviderId, index, serverVoices);
    },
    [agents, ttsProviderId, isBrowserTTS, browserAvailableVoices],
  );

  const processQueue = useCallback(async () => {
    if (isPlayingRef.current || queueRef.current.length === 0) return;
    if (!enabled || ttsMuted) {
      queueRef.current = [];
      return;
    }

    isPlayingRef.current = true;
    const item = queueRef.current.shift()!;

    if (isBrowserTTS) {
      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      browserSpeak(item.text, item.voiceId);
      // browserTTS onEnd callback resets isPlayingRef and calls processQueue
      return;
    }

    // Server TTS
    onAudioStateChangeRef.current?.(item.agentId, 'generating');
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const providerConfig = ttsProvidersConfig[ttsProviderId];
      // Match actual /api/generate/tts field names:
      // { text, audioId, ttsProviderId, ttsVoice, ttsSpeed, ttsApiKey, ttsBaseUrl }
      // Response: { audioId, base64, format }
      const res = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: item.text,
          audioId: item.partId,
          ttsProviderId: ttsProviderId,
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

      // Play via HTMLAudioElement directly (simpler than AudioPlayer for queued playback)
      onAudioStateChangeRef.current?.(item.agentId, 'playing');
      const audioUrl = `data:audio/${data.format || 'mp3'};base64,${data.base64}`;
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      audio.addEventListener('ended', () => {
        isPlayingRef.current = false;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        processQueueRef.current();
      });
      audio.addEventListener('error', () => {
        isPlayingRef.current = false;
        onAudioStateChangeRef.current?.(item.agentId, 'idle');
        processQueueRef.current();
      });
      await audio.play();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[DiscussionTTS] TTS generation failed:', err);
      }
      isPlayingRef.current = false;
      onAudioStateChangeRef.current?.(item.agentId, 'idle');
      processQueueRef.current(); // skip failed segment, continue queue
    }
  }, [enabled, ttsMuted, isBrowserTTS, ttsProviderId, ttsProvidersConfig, ttsSpeed, browserSpeak]);

  // Keep processQueueRef in sync
  processQueueRef.current = processQueue;

  // Called by StreamBuffer's onSegmentSealed
  const handleSegmentSealed = useCallback(
    (messageId: string, partId: string, fullText: string, agentId: string | null) => {
      if (!enabled || ttsMuted || !fullText.trim()) return;

      const voiceId = getVoiceForAgent(agentId);
      queueRef.current.push({ messageId, partId, text: fullText, agentId, voiceId });

      if (!isPlayingRef.current) {
        processQueueRef.current();
      } else if (!isBrowserTTS) {
        // Show generating indicator for queued items
        onAudioStateChangeRef.current?.(agentId, 'generating');
      }
    },
    [enabled, ttsMuted, getVoiceForAgent, isBrowserTTS],
  );

  // Cleanup: abort all, stop playback, clear queue
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
    onAudioStateChangeRef.current?.(null, 'idle');
  }, []); // stable — uses only refs

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  return {
    handleSegmentSealed,
    cleanup,
  };
}
