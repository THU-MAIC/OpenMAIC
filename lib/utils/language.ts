export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'hi-IN'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export function isSupportedLocale(value: string | null | undefined): value is AppLocale {
  return !!value && SUPPORTED_LOCALES.includes(value as AppLocale);
}

export function detectPreferredLocale(language?: string | null): AppLocale {
  if (!language) return 'en-US';
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('hi')) return 'hi-IN';
  return 'en-US';
}

export function getLanguageLabel(language: string): string {
  switch (language) {
    case 'zh-CN':
      return 'Chinese (Simplified)';
    case 'hi-IN':
      return 'Hindi';
    case 'en-US':
      return 'English';
    default:
      return language;
  }
}

export function isHindiLanguage(language?: string | null): boolean {
  return language === 'hi-IN' || language === 'hi';
}

export function isChineseLanguage(language?: string | null): boolean {
  return language === 'zh-CN' || language === 'zh';
}

export function getAsrLanguageForLocale(locale: string, providerId?: string): string {
  if (providerId === 'browser-native') {
    if (locale === 'hi-IN') return 'hi-IN';
    if (locale === 'en-US') return 'en-US';
    return 'zh-CN';
  }

  if (locale === 'hi-IN') return 'hi';
  if (locale === 'en-US') return 'en';
  return 'zh';
}

export function getDefaultTTSProviderForLocale(locale: string) {
  if (locale === 'hi-IN') return 'google-tts';
  if (locale === 'en-US') return 'openai-tts';
  return 'browser-native-tts';
}

export function getDefaultTTSVoiceForLocale(locale: string, providerId?: string) {
  if (providerId === 'google-tts' || locale === 'hi-IN') return 'hi-IN-Neural2-A';
  if (providerId === 'openai-tts' || locale === 'en-US') return 'alloy';
  return 'default';
}
