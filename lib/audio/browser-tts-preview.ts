'use client';

const VOICES_LOAD_TIMEOUT_MS = 2000;
const PREVIEW_TIMEOUT_MS = 30000;
const CJK_LANG_THRESHOLD = 0.3;

type PlayBrowserTTSPreviewOptions = {
  text: string;
  voice?: string;
  rate?: number;
  voices?: SpeechSynthesisVoice[];
};

function createAbortError(): Error {
  const error = new Error('Browser TTS preview canceled');
  error.name = 'AbortError';
  return error;
}

function inferPreviewLang(text: string): string {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const ratio = text.length > 0 ? cjkCount / text.length : 0;
  return ratio > CJK_LANG_THRESHOLD ? 'zh-CN' : 'en-US';
}

export function isBrowserTTSAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Wait for browser voices to load, with a 2s timeout fallback. */
export async function ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return [];
  }

  const initialVoices = window.speechSynthesis.getVoices();
  if (initialVoices.length > 0) {
    return initialVoices;
  }

  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;

    const cleanup = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(window.speechSynthesis.getVoices());
    };

    const handleVoicesChanged = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        finish();
      }
    };

    window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
    timeoutId = window.setTimeout(finish, VOICES_LOAD_TIMEOUT_MS);
  });
}

/** Resolve a browser voice by voiceURI, name, or lang, with language fallback by text. */
export function resolveBrowserVoice(
  voices: SpeechSynthesisVoice[],
  voiceNameOrLang: string,
  text: string,
): { voice: SpeechSynthesisVoice | null; lang: string } {
  const target = voiceNameOrLang.trim();
  const matchedVoice =
    target && target !== 'default'
      ? voices.find(
          (voice) => voice.voiceURI === target || voice.name === target || voice.lang === target,
        ) || null
      : null;

  return {
    voice: matchedVoice,
    lang: matchedVoice?.lang || inferPreviewLang(text),
  };
}

/**
 * Play a short browser-native TTS preview.
 *
 * Notes:
 * - Uses the global speechSynthesis queue, so it must cancel queued utterances
 *   before starting a new preview.
 * - Resolves only after the utterance has started and then ended successfully.
 */
export function playBrowserTTSPreview(options: PlayBrowserTTSPreviewOptions): {
  promise: Promise<void>;
  cancel: () => void;
} {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;

  if (!synth) {
    return {
      promise: Promise.reject(new Error('Browser does not support Speech Synthesis API')),
      cancel: () => {},
    };
  }

  let settled = false;
  let started = false;
  let canceled = false;
  let timeoutId: number | null = null;
  let rejectPromise: ((reason?: unknown) => void) | null = null;

  const settleResolve = (resolve: () => void) => {
    if (settled) return;
    settled = true;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    resolve();
  };

  const settleReject = (reject: (reason?: unknown) => void, reason: unknown) => {
    if (settled) return;
    settled = true;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    reject(reason);
  };

  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;

    const startPlayback = async () => {
      try {
        const voices = options.voices ?? (await ensureVoicesLoaded());
        if (canceled) {
          settleReject(reject, createAbortError());
          return;
        }
        if (voices.length === 0) {
          settleReject(reject, new Error('No browser TTS voices available'));
          return;
        }

        const utterance = new SpeechSynthesisUtterance(options.text);
        utterance.rate = options.rate ?? 1;

        const { voice, lang } = resolveBrowserVoice(voices, options.voice ?? '', options.text);
        if (voice) {
          utterance.voice = voice;
        }
        utterance.lang = lang;

        utterance.onstart = () => {
          started = true;
        };

        utterance.onend = () => {
          if (!started) {
            settleReject(reject, new Error('Browser TTS preview ended before playback started'));
            return;
          }
          settleResolve(resolve);
        };

        utterance.onerror = (event) => {
          if (canceled || event.error === 'canceled' || event.error === 'interrupted') {
            settleReject(reject, createAbortError());
            return;
          }
          settleReject(reject, new Error(event.error));
        };

        timeoutId = window.setTimeout(() => {
          synth.cancel();
          settleReject(reject, new Error('Browser TTS preview timed out'));
        }, PREVIEW_TIMEOUT_MS);

        synth.cancel();
        if (canceled) {
          settleReject(reject, createAbortError());
          return;
        }
        synth.speak(utterance);
      } catch (error) {
        settleReject(reject, error);
      }
    };

    void startPlayback();
  });

  const cancel = () => {
    if (settled || canceled) return;
    canceled = true;
    synth.cancel();
    if (rejectPromise) {
      settleReject(rejectPromise, createAbortError());
    }
  };

  return { promise, cancel };
}
