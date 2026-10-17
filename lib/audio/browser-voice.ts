/**
 * Voice a browser speaks when the requested URI is missing or the "default"
 * sentinel. Discussion reservation and playback both call this so they name
 * the same voice.
 *
 * Order: exact lang (case-insensitive, "_" and "-" equivalent), then the same
 * primary language, then `default === true`, then the first voice.
 */
export const BROWSER_TTS_DEFAULT_LANG = 'zh-CN';

export interface BrowserVoiceCandidate {
  voiceURI: string;
  name?: string;
  lang?: string;
  default?: boolean;
}

function normalizeBrowserVoiceLang(lang: string): string {
  return lang.trim().replace(/_/g, '-').toLowerCase();
}

function primaryBrowserVoiceLang(lang: string): string {
  const normalized = normalizeBrowserVoiceLang(lang);
  const dash = normalized.indexOf('-');
  return dash === -1 ? normalized : normalized.slice(0, dash);
}

export function resolveUnmatchedBrowserVoice<T extends BrowserVoiceCandidate>(
  voices: readonly T[],
  utteranceLang: string,
): T | undefined {
  if (voices.length === 0) return undefined;

  const target = normalizeBrowserVoiceLang(utteranceLang);
  if (target) {
    const exact = voices.find(
      (voice) => !!voice.lang && normalizeBrowserVoiceLang(voice.lang) === target,
    );
    if (exact) return exact;

    const primary = primaryBrowserVoiceLang(utteranceLang);
    if (primary) {
      const samePrimary = voices.find(
        (voice) => !!voice.lang && primaryBrowserVoiceLang(voice.lang) === primary,
      );
      if (samePrimary) return samePrimary;
    }
  }

  return voices.find((voice) => voice.default === true) ?? voices[0];
}
