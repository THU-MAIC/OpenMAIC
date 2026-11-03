import { supportedLocales } from './locales';

export type Locale = (typeof supportedLocales)[number]['code'];

export const defaultLocale: Locale = 'zh-CN';

/** A supported locale code exactly as given, or undefined for anything else. */
export function supportedLocaleOf(value: unknown): Locale | undefined {
  return typeof value === 'string' && supportedLocales.some((locale) => locale.code === value)
    ? (value as Locale)
    : undefined;
}
