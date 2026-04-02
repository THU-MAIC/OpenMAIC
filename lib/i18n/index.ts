import { defaultLocale, type Locale } from './types';
export { type Locale, defaultLocale } from './types';
import { commonZhCN, commonEnUS, commonRuRU } from './common';
import { stageZhCN, stageEnUS, stageRuRU } from './stage';
import { chatZhCN, chatEnUS, chatRuRU } from './chat';
import { generationZhCN, generationEnUS, generationRuRU } from './generation';
import { settingsZhCN, settingsEnUS, settingsRuRU } from './settings';

export const translations = {
  'zh-CN': {
    ...commonZhCN,
    ...stageZhCN,
    ...chatZhCN,
    ...generationZhCN,
    ...settingsZhCN,
  },
  'en-US': {
    ...commonEnUS,
    ...stageEnUS,
    ...chatEnUS,
    ...generationEnUS,
    ...settingsEnUS,
  },
  'ru-RU': {
    ...commonRuRU,
    ...stageRuRU,
    ...chatRuRU,
    ...generationRuRU,
    ...settingsRuRU,
  },
} as const;

export type TranslationKey = keyof (typeof translations)[typeof defaultLocale];

export function translate(locale: Locale, key: string): string {
  const keys = key.split('.');
  let value: unknown = translations[locale];
  for (const k of keys) {
    value = (value as Record<string, unknown>)?.[k];
  }

  if (typeof value === 'string') return value;

  let fallback: unknown = translations['en-US'];
  for (const k of keys) {
    fallback = (fallback as Record<string, unknown>)?.[k];
  }

  return (typeof fallback === 'string' ? fallback : undefined) ?? key;
}

export function getClientTranslation(key: string): string {
  let locale: Locale = defaultLocale;

  if (typeof window !== 'undefined') {
    try {
      const storedLocale = localStorage.getItem('locale');
      if (storedLocale === 'zh-CN' || storedLocale === 'en-US' || storedLocale === 'ru-RU') {
        locale = storedLocale;
      }
    } catch {
      // localStorage unavailable, keep default locale
    }
  }

  return translate(locale, key);
}
