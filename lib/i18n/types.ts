import { supportedLocales } from './locales';

export type Locale = (typeof supportedLocales)[number]['code'];

export const defaultLocale: Locale = 'zh-CN';
