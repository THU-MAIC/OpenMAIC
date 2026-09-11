'use client';

const VOICES_LOAD_TIMEOUT_MS = 2000;
const PREVIEW_TIMEOUT_MS = 30000;
const CJK_LANG_THRESHOLD = 0.3;

type PlayBrowserTTSPreviewOptions = {
  text: string;
  voice?: string;
  rate?: number;
  voices?: SpeechSynthesisVoice[];
  locale?: string; // UI locale (zh-CN, zh-TW, en-US) for language selection
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

/**
 * Map UI locale to browser TTS language code.
 * zh-TW (Traditional Chinese) → zh-HK (Cantonese - better voice quality)
 * zh-CN (Simplified Chinese) → zh-CN
 * en-US → en-US
 */
function localeToBrowserTTSLang(locale: string): string {
  if (locale === 'zh-TW') {
    return 'zh-HK';
  }
  if (locale === 'zh-CN') {
    return 'zh-CN';
  }
  return 'en-US';
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

/** Resolve a browser voice by voiceURI, name, or lang, with language fallback by locale or text. */
export function resolveBrowserVoice(
  voices: SpeechSynthesisVoice[],
  voiceNameOrLang: string,
  text: string,
  locale?: string,
): { voice: SpeechSynthesisVoice | null; lang: string } {
  const target = voiceNameOrLang.trim();
  const matchedVoice =
    target && target !== 'default'
      ? voices.find(
          (voice) => voice.voiceURI === target || voice.name === target || voice.lang === target,
        ) || null
      : null;

  if (matchedVoice) {
    return {
      voice: matchedVoice,
      lang: matchedVoice.lang,
    };
  }

  // No voice matched — use locale if provided, otherwise infer from text
  const lang = locale ? localeToBrowserTTSLang(locale) : inferPreviewLang(text);
  return {
    voice: null,
    lang,
  };
}

/**
 * Get available language codes from voices, sorted by preference.
 */
function getAvailableLangs(voices: SpeechSynthesisVoice[]): string[] {
  const langSet = new Set(voices.map((v) => v.lang));
  return Array.from(langSet);
}

/**
 * Play a short browser-native TTS preview.
 *
 * Notes:
 * - Uses the global speechSynthesis queue, so it must cancel queued utterances
 *   before starting a new preview.
 * - Resolves only after the utterance has started and then ended successfully.
 * - Falls back to alternative languages if synthesis fails.
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

  /** Create and configure an utterance with the given lang. */
  const createUtterance = (lang: string): SpeechSynthesisUtterance => {
    const utterance = new SpeechSynthesisUtterance(options.text);
    utterance.rate = options.rate ?? 1;

    const voices = options.voices ?? [];
    const { voice } = resolveBrowserVoice(voices, options.voice ?? '', options.text, lang);
    if (voice) {
      utterance.voice = voice;
    }
    utterance.lang = lang;

    return utterance;
  };

  /** Try to speak the utterance and return a promise that settles. */
  const trySpeak = (utterance: SpeechSynthesisUtterance): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let started = false;

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
        if (canceled) {
          settleReject(reject, createAbortError());
          return;
        }
        // Check for both 'canceled' (browser variant) and 'cancelled' (spec)
        const rawError = (event as unknown as { error: unknown }).error;
        const errorMessage =
          rawError instanceof Error ? rawError.message : String(rawError ?? 'synthesis-failed');
        if (
          errorMessage === 'canceled' ||
          errorMessage === 'cancelled' ||
          errorMessage === 'interrupted'
        ) {
          settleReject(reject, createAbortError());
          return;
        }
        // Pass through the actual browser error for fallback handling
        reject(new Error(errorMessage));
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
    });
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

        // Determine primary language
        const primaryLang =
          options.locale && options.locale !== 'default'
            ? localeToBrowserTTSLang(options.locale)
            : inferPreviewLang(options.text);

        // Build fallback language list: primary first, then other available langs
        const availableLangs = getAvailableLangs(voices);
        const fallbackLangs = availableLangs.filter((l) => l !== primaryLang);

        // Try primary language first, then fall back to alternatives
        const langsToTry = [primaryLang, ...fallbackLangs];
        let lastError: Error | null = null;

        for (const lang of langsToTry) {
          if (canceled) {
            settleReject(reject, createAbortError());
            return;
          }
          try {
            const utterance = createUtterance(lang);
            await trySpeak(utterance);
            return;
          } catch (error) {
            lastError = error as Error;
            // If this was an abort, propagate it
            if (isBrowserTTSAbortError(error)) {
              throw error;
            }
          }
        }

        // All languages failed
        settleReject(reject, lastError ?? new Error('Browser TTS synthesis failed'));
      } catch (error) {
        if (!isBrowserTTSAbortError(error)) {
          settleReject(reject, error);
        }
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
