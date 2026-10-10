'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Locale, defaultLocale } from '@/lib/i18n';
import i18n from '@/lib/i18n/config';
import { loadLocaleResource, type TranslationResource } from '@/lib/i18n/load-resource';
import { LOCALE_COOKIE, localeCookie, matchLocale } from '@/lib/i18n/resolve-locale';

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

type I18nProviderProps = {
  children: ReactNode;
  /** The locale the server rendered with (see `resolveRequestLocale`). */
  initialLocale?: Locale;
  /** Its bundle, so the first client render translates exactly like the server. */
  initialResources?: TranslationResource;
};

// Cookie and storage access both throw in sandboxed iframes.
function persistLocale(locale: Locale) {
  try {
    document.cookie = localeCookie(locale);
  } catch {
    // cookies unavailable
  }
  try {
    localStorage.setItem(LOCALE_COOKIE, locale);
  } catch {
    // localStorage unavailable
  }
}

function cookieLocale(): Locale | undefined {
  try {
    const prefix = `${LOCALE_COOKIE}=`;
    const entry = document.cookie.split('; ').find((c) => c.startsWith(prefix));
    return matchLocale(entry?.slice(prefix.length));
  } catch {
    return undefined;
  }
}

/**
 * Load a locale's bundle ourselves rather than through `changeLanguage`:
 * i18next 26 still switches language when the backend load fails, and marks
 * that load failed for good, so a later attempt would never retry it.
 */
async function ensureBundle(locale: Locale): Promise<boolean> {
  if (i18n.hasResourceBundle(locale, 'translation')) return true;
  try {
    i18n.addResourceBundle(locale, 'translation', await loadLocaleResource(locale));
    return true;
  } catch (error) {
    console.error(
      `[i18n] Could not load the ${locale} translations; keeping the current language.`,
      error,
    );
    return false;
  }
}

export function I18nProvider({
  children,
  initialLocale = defaultLocale,
  initialResources,
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialResources && !i18n.hasResourceBundle(initialLocale, 'translation')) {
      i18n.addResourceBundle(initialLocale, 'translation', initialResources);
    }
    return initialLocale;
  });
  const requestedLocale = useRef(locale);

  // `t` is fixed to `locale` rather than to i18next's global language: the
  // server shares one i18next instance across requests, so it must not switch
  // it per request. The subscription still re-renders on language changes and
  // loads, and `useSuspense: false` keeps hydration from suspending while
  // i18next finishes its own (asynchronous) init.
  const translationOptions = useMemo(() => ({ lng: locale, useSuspense: false }), [locale]);
  const { t } = useTranslation(undefined, translationOptions);

  const setLocale = (newLocale: Locale) => {
    const previous = locale;
    requestedLocale.current = newLocale;
    persistLocale(newLocale);
    // The UI stays on the current locale until the new bundle is in, rather
    // than showing the new locale half-translated. A slower earlier switch
    // that finishes after a later one is dropped, and a failed load puts the
    // previous choice back (a later attempt loads again).
    const apply = async () => {
      const loaded = await ensureBundle(newLocale);
      if (requestedLocale.current !== newLocale) return;
      if (!loaded) {
        requestedLocale.current = previous;
        persistLocale(previous);
        return;
      }
      await i18n.changeLanguage(newLocale);
      if (requestedLocale.current !== newLocale) return;
      document.documentElement.lang = newLocale;
      setLocaleState(newLocale);
    };
    apply().catch((error) => console.error('[i18n] Language switch failed.', error));
  };

  useEffect(() => {
    // Hook-free callers (`getClientTranslation`) read i18next's global language.
    if (i18n.language !== initialLocale) void i18n.changeLanguage(initialLocale);

    // Earlier versions kept the choice only in localStorage, which the server
    // cannot read. Carry it over once; from then on the cookie decides.
    if (cookieLocale()) return;
    let stored: Locale | undefined;
    try {
      stored = matchLocale(localStorage.getItem(LOCALE_COOKIE));
    } catch {
      // localStorage unavailable
    }
    if (stored === initialLocale) persistLocale(stored);
    else if (stored) setLocale(stored);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
