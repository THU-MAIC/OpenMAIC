/**
 * Authoritative list of explanation languages OpenMAIC supports.
 * All of these are handled fluently by the underlying LLMs.
 * learning.thomhoffer uses this list when asking users for their base language.
 *
 * Keys are BCP-47 codes passed as `explanationLanguage` in the generate-classroom request.
 * Values are the native name shown to the user.
 */
export const BASE_LANGUAGE_NAMES: Record<string, string> = {
  'en-US': 'English',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'pt-BR': 'Português',
  'it-IT': 'Italiano',
  'nl-NL': 'Nederlands',
  'pl-PL': 'Polski',
  'uk-UA': 'Українська',
  'ru-RU': 'Русский',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'zh-CN': '中文（简体）',
  'ar-SA': 'العربية',
  'hi-IN': 'हिन्दी',
  'tr-TR': 'Türkçe',
  'sv-SE': 'Svenska',
  'da-DK': 'Dansk',
  'fi-FI': 'Suomi',
  'nb-NO': 'Norsk',
};

/** Ordered array for rendering a language picker. */
export const BASE_LANGUAGE_LIST = Object.entries(BASE_LANGUAGE_NAMES).map(
  ([code, label]) => ({ code, label }),
);
