import { defaultLocale, type Locale } from './types';
import { supportedLocales } from './locales';

/** Shared with `localStorage` so an explicit language switch updates both. */
export const LOCALE_COOKIE_NAME = 'locale';
export const LOCALE_STORAGE_KEY = 'locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type RequestLocaleInput = {
  cookie?: string | null;
  acceptLanguage?: string | null;
};

/**
 * Map a language tag onto a supported locale.
 *
 * Exact match wins (case-insensitive). Otherwise the language subtag is
 * matched as a prefix (`en` → `en-US`, `zh` → `zh-CN`). Returns `undefined`
 * when nothing in the registry matches, so callers can fall through.
 */
export function matchLocale(lang: string): Locale | undefined {
  const trimmed = lang.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.toLowerCase();
  const exact = supportedLocales.find((l) => l.code.toLowerCase() === normalized);
  if (exact) return exact.code;

  const prefix = normalized.split('-')[0];
  if (!prefix) return undefined;
  const match = supportedLocales.find((l) => {
    const code = l.code.toLowerCase();
    return code === prefix || code.startsWith(`${prefix}-`);
  });
  return match?.code;
}

/** Same mapping as `matchLocale`, falling back to `defaultLocale`. */
export function resolveLocale(lang: string): Locale {
  return matchLocale(lang) ?? defaultLocale;
}

/**
 * Parse an `Accept-Language` header into tags, highest quality first.
 * `*` and empty tokens are dropped.
 */
export function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().toLowerCase().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

/**
 * Server/client shared initial-locale decision:
 * cookie (exact or prefix) → Accept-Language → `defaultLocale`.
 *
 * An unsupported cookie does not pin the user to `defaultLocale`; it falls
 * through to the header so a stale or garbage value cannot hide the browser
 * language.
 */
export function resolveRequestLocale({ cookie, acceptLanguage }: RequestLocaleInput): Locale {
  const fromCookie = cookie ? matchLocale(cookie) : undefined;
  if (fromCookie) return fromCookie;

  if (acceptLanguage) {
    for (const tag of parseAcceptLanguage(acceptLanguage)) {
      const fromHeader = matchLocale(tag);
      if (fromHeader) return fromHeader;
    }
  }

  return defaultLocale;
}

/** BCP 47 language subtag for `<html lang>`. */
export function htmlLangFromLocale(locale: Locale): string {
  return locale.split('-')[0].toLowerCase();
}

export function serializeLocaleCookie(locale: Locale): string {
  return `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}
