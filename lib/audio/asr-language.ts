/**
 * Default ASR language from the UI locale.
 *
 * Why: the store's default `asrLanguage` was a literal (`'zh-CN'`) regardless
 * of the interface language, so a non-Chinese UI had its microphone transcribed
 * as Chinese until the user found the language menu.
 *
 * Client-safe: no Node imports. `defaultLocale` is a compile-time constant
 * (`lib/i18n/types.ts`), the same value `<html lang>` and the browser TTS
 * fallback already follow — three surfaces, one source.
 */

import { ASR_PROVIDERS, CUSTOM_ASR_DEFAULT_LANGUAGES } from './constants';
import { isCustomASRProvider } from './types';
import { defaultLocale } from '@/lib/i18n/types';

/**
 * Pick the entry of `providerId`'s `supportedLanguages` that best matches
 * `locale` (BCP-47, e.g. `tr-TR`): exact code → bare language (`tr`) → a code
 * sharing the language prefix (`tr-TR` for a list that only has full tags) →
 * `auto` → the list's first entry → the locale itself. Custom providers use
 * CUSTOM_ASR_DEFAULT_LANGUAGES, like getValidASRLanguage in the store.
 */
export function defaultASRLanguage(providerId: string, locale: string = defaultLocale): string {
  const languages: readonly string[] = isCustomASRProvider(providerId)
    ? CUSTOM_ASR_DEFAULT_LANGUAGES
    : (ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS]?.supportedLanguages ?? []);
  const wanted = locale.trim();
  const prefix = wanted.split('-')[0].toLowerCase();
  if (languages.includes(wanted)) return wanted;
  if (languages.includes(prefix)) return prefix;
  const byPrefix = languages.find(
    (code) => code !== 'auto' && code.split('-')[0].toLowerCase() === prefix,
  );
  if (byPrefix) return byPrefix;
  if (languages.includes('auto')) return 'auto';
  return languages[0] ?? wanted;
}
