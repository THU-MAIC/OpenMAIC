import { defaultLocale } from './types';
export { type Locale, defaultLocale } from './types';
import { commonZhCN, commonEnUS } from './common';
import { stageZhCN, stageEnUS } from './stage';
import { chatZhCN, chatEnUS } from './chat';
import { generationZhCN, generationEnUS } from './generation';
import { settingsZhCN, settingsEnUS } from './settings';

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
} as const;

export type TranslationKey = keyof (typeof translations)[typeof defaultLocale];
