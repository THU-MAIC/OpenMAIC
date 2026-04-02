import { defaultLocale, type Locale } from './types';
export { type Locale, defaultLocale } from './types';
import { commonZhCN, commonEnUS } from './common';
import { stageZhCN, stageEnUS } from './stage';
import { chatZhCN, chatEnUS } from './chat';
import { generationZhCN, generationEnUS } from './generation';
import { settingsZhCN, settingsEnUS } from './settings';
import { commonZhTW } from './common-zhTW';
import { stageZhTW } from './stage-zhTW';
import { chatZhTW } from './chat-zhTW';
import { generationZhTW } from './generation-zhTW';
import { settingsZhTW } from './settings-zhTW';

export const translations = {
  'zh-CN': {
    ...commonZhCN,
    ...stageZhCN,
    ...chatZhCN,
    ...generationZhCN,
    ...settingsZhCN,
  },
  'zh-TW': {
    ...commonZhTW,
    ...stageZhTW,
    ...chatZhTW,
    ...generationZhTW,
    ...settingsZhTW,
  },
  'en-US': {
    ...commonEnUS,
    ...stageEnUS,
    ...chatEnUS,
    ...generationEnUS,
    ...settingsEnUS,
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
      if (storedLocale === 'zh-CN' || storedLocale === 'zh-TW' || storedLocale === 'en-US') {
        locale = storedLocale;
      }
    } catch {
      // localStorage unavailable, keep default locale
    }
  }

  return translate(locale, key);
}
