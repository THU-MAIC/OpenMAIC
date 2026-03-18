'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Locale, translate, defaultLocale } from '@/lib/i18n';

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
};

const LOCALE_STORAGE_KEY = 'locale';
const VALID_LOCALES: Locale[] = ['zh-CN', 'en-US'];

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  // Hydrate from localStorage after mount (avoids SSR mismatch)
  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect */
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && VALID_LOCALES.includes(stored as Locale)) {
        setLocaleState(stored as Locale);
        return;
      }
      const detected = navigator.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
      localStorage.setItem(LOCALE_STORAGE_KEY, detected);
      setLocaleState(detected);
    } catch {
      // localStorage unavailable, keep default
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
  };

  const t = (key: string): string => translate(locale, key);

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
