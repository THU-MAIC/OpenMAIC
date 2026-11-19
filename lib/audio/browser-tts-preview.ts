'use client';

import { BrowserSpeechPlayer } from '@/lib/audio/browser-speech-player';
import { getBrowserVoiceCatalog } from '@/lib/audio/browser-speech-synthesis';

const PREVIEW_TIMEOUT_MS = 30000;

type PlayBrowserTTSPreviewOptions = {
  text: string;
  voice?: string;
  rate?: number;
  /** UI language for the Chinese region or text without a strong language signal. */
  locale?: string;
};

function createAbortError(): Error {
  const error = new Error('Browser TTS preview canceled');
  error.name = 'AbortError';
  return error;
}

export function isBrowserTTSAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Play a short browser-native TTS preview.
 *
 * Notes:
 * - Uses the global speechSynthesis queue, so starting a preview cancels
 *   whatever the page was speaking, and other speech cancels the preview
 *   (which then rejects with an AbortError).
 * - Resolves only after the speech has started and then ended successfully;
 *   rejects on the first failed sentence or after 30 seconds.
 */
export function playBrowserTTSPreview(options: PlayBrowserTTSPreviewOptions): {
  promise: Promise<void>;
  cancel: () => void;
} {
  const player = new BrowserSpeechPlayer({ stallGuard: false });

  if (!player.isSupported()) {
    return {
      promise: Promise.reject(new Error('Browser does not support Speech Synthesis API')),
      cancel: () => {},
    };
  }

  let settled = false;
  let started = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settle: (error?: unknown) => void = () => {};

  const promise = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      player.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
  });

  const startPlayback = async () => {
    const voices = await getBrowserVoiceCatalog().load();
    if (settled) return;
    if (voices.length === 0) {
      settle(new Error('No browser TTS voices available'));
      return;
    }

    player.onStart(() => {
      started = true;
    });
    player.onEnded(() => {
      settle(started ? undefined : new Error('Browser TTS preview ended before playback started'));
    });
    player.onError(({ code }) => {
      settle(code === 'canceled' || code === 'interrupted' ? createAbortError() : new Error(code));
    });
    timeoutId = setTimeout(() => {
      settle(new Error('Browser TTS preview timed out'));
    }, PREVIEW_TIMEOUT_MS);

    const playing = await player.play(options.text, {
      voice: options.voice,
      rate: options.rate ?? 1,
      locale: options.locale,
    });
    if (!playing) settle(new Error('Browser TTS preview ended before playback started'));
  };
  startPlayback().catch((error: unknown) => settle(error));

  const cancel = () => settle(createAbortError());

  return { promise, cancel };
}
