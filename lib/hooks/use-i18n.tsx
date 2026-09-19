'use client';

import { createContext, useContext, useState, ReactNode } from 'react';
import { type Locale, defaultLocale } from '@/lib/i18n/types';
import {
  LOCALE_STORAGE_KEY,
  htmlLangFromLocale,
  serializeLocaleCookie,
} from '@/lib/i18n/resolve-locale';
import i18n from '@/lib/i18n/config';

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

type I18nProviderProps = {
  children: ReactNode;
  /** Server-chosen locale. First paint must not re-detect from the browser. */
  initialLocale?: Locale;
  /** Resource bundle for `initialLocale`, so hydration can resolve `t()` synchronously. */
  initialResources?: Record<string, unknown>;
};

function applyInitialLocale(locale: Locale, resources?: Record<string, unknown>) {
  if (resources && !i18n.hasResourceBundle(locale, 'translation')) {
    i18n.addResourceBundle(locale, 'translation', resources, true, true);
  }
  if (i18n.language !== locale) {
    void i18n.changeLanguage(locale);
  }
}

export function I18nProvider({
  children,
  initialLocale = defaultLocale,
  initialResources,
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    applyInitialLocale(initialLocale, initialResources);
    return initialLocale;
  });

  const t = (key: string, options?: Record<string, unknown>) =>
    i18n.t(key, { ...(options ?? {}), lng: locale }) as string;

  const setLocale = (newLocale: Locale) => {
    applyInitialLocale(newLocale);
    setLocaleState(newLocale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = htmlLangFromLocale(newLocale);
      document.cookie = serializeLocaleCookie(newLocale);
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
      } catch {
        // localStorage unavailable
      }
    }
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
