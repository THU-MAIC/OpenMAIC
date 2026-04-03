import { defaultLocale, type Locale, VALID_LOCALES } from './types';
export { type Locale, defaultLocale, VALID_LOCALES } from './types';
import { commonZhCN, commonEnUS, commonCa } from './common';
import { stageZhCN, stageEnUS, stageCa } from './stage';
import { chatZhCN, chatEnUS, chatCa } from './chat';
import { generationZhCN, generationEnUS, generationCa } from './generation';
import { settingsZhCN, settingsEnUS, settingsCa } from './settings';

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
  'ca': {
    ...commonCa,
    ...stageCa,
    ...chatCa,
    ...generationCa,
    ...settingsCa,
  },
} as const;

export type TranslationKey = keyof (typeof translations)[typeof defaultLocale];

export function translate(locale: Locale, key: string): string {
  const keys = key.split('.');
  let value: unknown = translations[locale];
  for (const k of keys) {
    value = (value as Record<string, unknown>)?.[k];
  }
  return (typeof value === 'string' ? value : undefined) ?? key;
}

export function getClientTranslation(key: string): string {
  let locale: Locale = defaultLocale;

  if (typeof window !== 'undefined') {
    try {
      const storedLocale = localStorage.getItem('locale');
      if (storedLocale && VALID_LOCALES.includes(storedLocale as Locale)) {
        locale = storedLocale as Locale;
      }
    } catch {
      // localStorage unavailable, keep default locale
    }
  }

  return translate(locale, key);
}
