import { supportedLocales } from './locales';
import { defaultLocale, type Locale } from './types';

/**
 * Cookie holding the user's explicit language choice. The same key in
 * localStorage is what earlier versions wrote, and what a few hook-free
 * readers still consult.
 */
export const LOCALE_COOKIE = 'locale';

/**
 * Map a language tag onto a supported locale: an exact match (any case),
 * else the first registered locale with the same language subtag
 * (`en-GB` → `en-US`, `zh` → `zh-CN`; see `TRANSLATION_GUIDE.md` on order).
 */
export function matchLocale(tag: string | null | undefined): Locale | undefined {
  const lower = tag?.trim().toLowerCase();
  if (!lower) return undefined;
  const exact = supportedLocales.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  const language = `${lower.split('-')[0]}-`;
  return supportedLocales.find((l) => l.code.toLowerCase().startsWith(language))?.code;
}

/** `Accept-Language` tags, most preferred first, without `*` or `q=0` entries. */
function acceptedTags(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.split(';').map((s) => s.trim());
      const q = params.find((p) => p.startsWith('q='));
      return { tag, q: q ? Number(q.slice(2)) : 1 };
    })
    .filter(({ tag, q }) => tag && tag !== '*' && q > 0)
    .sort((a, b) => b.q - a.q)
    .map(({ tag }) => tag);
}

/**
 * The one initial-locale decision server and client share: the locale cookie,
 * else `Accept-Language`, else `defaultLocale`. An unsupported cookie value
 * falls through rather than pinning the user to the default.
 */
export function resolveRequestLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return (
    matchLocale(input.cookie) ??
    acceptedTags(input.acceptLanguage ?? '')
      .map((tag) => matchLocale(tag))
      .find((locale) => locale !== undefined) ??
    defaultLocale
  );
}

export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
