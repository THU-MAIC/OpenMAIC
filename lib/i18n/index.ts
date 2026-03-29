import { defaultLocale, type Locale } from './types';
export { type Locale, defaultLocale } from './types';
import { commonZhCN, commonEnUS, commonIdID, commonArSA } from './common';
import { stageZhCN, stageEnUS, stageIdID, stageArSA } from './stage';
import { chatZhCN, chatEnUS, chatIdID, chatArSA } from './chat';
import { generationZhCN, generationEnUS, generationIdID, generationArSA } from './generation';
import { settingsZhCN, settingsEnUS, settingsIdID, settingsArSA } from './settings';

export const translations = {
  'id-ID': {
    ...commonIdID,
    ...stageIdID,
    ...chatIdID,
    ...generationIdID,
    ...settingsIdID,
  },
  'en-US': {
    ...commonEnUS,
    ...stageEnUS,
    ...chatEnUS,
    ...generationEnUS,
    ...settingsEnUS,
  },
  'ar-SA': {
    ...commonArSA,
    ...stageArSA,
    ...chatArSA,
    ...generationArSA,
    ...settingsArSA,
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
      if (storedLocale === 'en-US' || storedLocale === 'id-ID' || storedLocale === 'ar-SA') {
        locale = storedLocale;
      }
    } catch {
      // localStorage unavailable, keep default locale
    }
  }

  return translate(locale, key);
}
