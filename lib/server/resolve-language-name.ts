/**
 * Resolves a BCP-47 or ISO-639 language code to a human-readable English name.
 *
 * Strategy (in order):
 * 1. Use `Intl.DisplayNames` when available (Node 12+/modern browsers) — covers
 *    virtually every BCP-47 tag without a hardcoded map.
 * 2. Fall back to a small static map for the most common codes, in case the
 *    runtime has an incomplete ICU data set.
 * 3. Pass the code through as-is if nothing resolves it, so prompts remain
 *    readable rather than silently wrong.
 */

const FALLBACK_MAP: Record<string, string> = {
  // Full BCP-47 variants
  'en-US': 'English',
  'en-GB': 'English',
  'lt-LT': 'Lithuanian',
  'es-ES': 'Spanish',
  'es-MX': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'pt-BR': 'Portuguese',
  'pt-PT': 'Portuguese',
  'it-IT': 'Italian',
  'nl-NL': 'Dutch',
  'pl-PL': 'Polish',
  'uk-UA': 'Ukrainian',
  'ru-RU': 'Russian',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'zh-CN': 'Chinese',
  'zh-TW': 'Chinese',
  'ar-SA': 'Arabic',
  'hi-IN': 'Hindi',
  'tr-TR': 'Turkish',
  'sv-SE': 'Swedish',
  'da-DK': 'Danish',
  'fi-FI': 'Finnish',
  'nb-NO': 'Norwegian',
  // ISO-639-1 short codes
  en: 'English',
  lt: 'Lithuanian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  hi: 'Hindi',
  tr: 'Turkish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  nb: 'Norwegian',
};

let _displayNames: Intl.DisplayNames | null | undefined; // undefined = not yet tried; null = not available

function getDisplayNames(): Intl.DisplayNames | null {
  if (_displayNames !== undefined) return _displayNames;
  try {
    _displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    _displayNames = null;
  }
  return _displayNames;
}

/**
 * Returns the English display name for the given language code.
 *
 * @param code - BCP-47 or ISO-639-1/2/3 code (e.g. 'lt-LT', 'lt', 'fr-FR').
 * @returns English name (e.g. 'Lithuanian'), or the original code if unresolvable.
 */
export function resolveLanguageName(code: string | undefined | null): string {
  if (!code) return 'the target language';

  // 1. Intl.DisplayNames (most accurate, covers all BCP-47 tags)
  const dn = getDisplayNames();
  if (dn) {
    try {
      const name = dn.of(code);
      if (name && name !== code) return name;
    } catch {
      // Intl threw for this specific code — fall through to static map
    }
  }

  // 2. Static fallback map
  const direct = FALLBACK_MAP[code];
  if (direct) return direct;

  // 3. Try base language code (strip region subtag, e.g. 'lt-LT' → 'lt')
  const base = code.split('-')[0];
  if (base && base !== code) {
    const baseName = FALLBACK_MAP[base];
    if (baseName) return baseName;
  }

  // 4. Pass through as-is — still readable and not silently wrong
  return code;
}
