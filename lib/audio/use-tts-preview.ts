'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ensureVoicesLoaded,
  isBrowserTTSAbortError,
  playBrowserTTSPreview,
} from '@/lib/audio/browser-tts-preview';

export interface TTSPreviewOptions {
  text: string;
  providerId: string;
  modelId?: string;
  voice: string;
  speed: number;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Shared hook for TTS preview playback (browser-native and API-based).
 *
 * - `previewing`: true while a preview is active (including audio playback)
 * - `startPreview(opts)`: start a preview; rejects with non-abort errors
 * - `stopPreview()`: cancel any active preview and reset state
 */
export function useTTSPreview() {
  const [previewing, setPreviewing] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const requestIdRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  /** Cancel in-flight work and release resources (no state update). */
  const cleanup = useCallback(() => {
    requestIdRef.current += 1;
    cancelRef.current?.();
    cancelRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  /** Cancel any active preview and reset the previewing flag. */
  const stopPreview = useCallback(() => {
    cleanup();
    setPreviewing(false);
  }, [cleanup]);

  // Cleanup on unmount (skip state update to avoid React warnings).
  useEffect(() => cleanup, [cleanup]);

  /**
   * Start a TTS preview.
   * Abort errors are swallowed; all other errors are re-thrown for the caller.
   */
  const startPreview = useCallback(
    async (options: TTSPreviewOptions): Promise<void> => {
      cleanup();
      const requestId = ++requestIdRef.current;
      const isStale = () => requestIdRef.current !== requestId;

      setPreviewing(true);
      try {
        if (options.providerId === 'browser-native-tts') {
          if (typeof window === 'undefined' || !window.speechSynthesis) {
            throw new Error('Browser does not support Speech Synthesis API');
          }
          const voices = await ensureVoicesLoaded();
          if (isStale()) return;
          if (voices.length === 0) {
            throw new Error('No browser TTS voices available');
          }
          const controller = playBrowserTTSPreview({
            text: options.text,
            voice: options.voice,
            rate: options.speed,
            voices,
          });
          cancelRef.current = controller.cancel;
          await controller.promise;
          if (!isStale()) {
            cancelRef.current = null;
            setPreviewing(false);
          }
          return;
        }

        // API-based TTS
        const body: Record<string, unknown> = {
          text: options.text,
          audioId: 'preview',
          ttsProviderId: options.providerId,
          ttsModelId: options.modelId,
          ttsVoice: options.voice,
          ttsSpeed: options.speed,
        };
        if (options.apiKey?.trim()) body.ttsApiKey = options.apiKey;
        if (options.baseUrl?.trim()) body.ttsBaseUrl = options.baseUrl;

        const res = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (isStale()) return;

        const data = await res.json().catch(() => ({ error: res.statusText }));
        if (isStale()) return;

        if (!res.ok || !data.base64) {
          throw new Error(data.error || 'TTS preview failed');
        }

        // Decode base64 → Blob → Object URL
        const binaryStr = atob(data.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: `audio/${data.format || 'mp3'}` });

        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          if (!isStale()) {
            audioRef.current = null;
            setPreviewing(false);
          }
        };
        audio.onerror = () => {
          if (!isStale()) {
            audioRef.current = null;
            setPreviewing(false);
          }
        };
        await audio.play();
      } catch (error) {
        if (!isStale()) {
          cancelRef.current = null;
          setPreviewing(false);
        }
        if (!isBrowserTTSAbortError(error)) {
          throw error;
        }
      }
    },
    [cleanup],
  );

  return { previewing, startPreview, stopPreview };
}
