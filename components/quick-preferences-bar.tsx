'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Moon, Sun, Monitor, Type } from 'lucide-react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { QUICK_PREFERENCES_OPT_OUT_EVENT } from '@/components/quick-preferences-opt-out';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { cn } from '@/lib/utils';

const FONT_SIZE_KEY = 'openmaic-ui-font-size';

const FONT_SIZES = [
  { key: 'quickPreferences.small', value: 14 },
  { key: 'quickPreferences.default', value: 16 },
  { key: 'quickPreferences.large', value: 18 },
] as const;

function applyRootFontSize(size: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${size}px`;
}

export function QuickPreferencesBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  const [themeOpen, setThemeOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [fontSize, setFontSize] = useState<number>(16);
  const [isOptedOut, setIsOptedOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const isSignInPage = pathname?.startsWith('/auth/signin');
  const hasPageSpecificPrefs = pathname === '/' || pathname?.startsWith('/classroom/');

  useEffect(() => {
    if (!themeOpen && !fontSizeOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
        setFontSizeOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [themeOpen, fontSizeOpen]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(FONT_SIZE_KEY);
      const parsed = saved ? Number(saved) : 16;
      const next = Number.isFinite(parsed) && [14, 16, 18].includes(parsed) ? parsed : 16;
      setFontSize(next);
      applyRootFontSize(next);
    } catch {
      // Ignore storage read errors
    }
  }, []);

  useEffect(() => {
    try {
      applyRootFontSize(fontSize);
      localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    } catch {
      // Ignore storage write errors
    }
  }, [fontSize]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const syncOptOutState = () => {
      const fromBody = document.body.dataset.quickPreferencesOptOut === '1';
      const fromCounter = (window.__quickPreferencesOptOutCount ?? 0) > 0;
      setIsOptedOut(fromBody || fromCounter);
    };

    syncOptOutState();
    window.addEventListener(QUICK_PREFERENCES_OPT_OUT_EVENT, syncOptOutState);
    return () => window.removeEventListener(QUICK_PREFERENCES_OPT_OUT_EVENT, syncOptOutState);
  }, [pathname]);

  if (status === 'loading') return null;
  if (!session?.user) return null;
  if (isSignInPage) return null;
  if (hasPageSpecificPrefs) return null;
  if (isOptedOut) return null;

  return (
    <div
      ref={rootRef}
      className="w-full flex items-center justify-end gap-1 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md px-4 py-1.5 border-b border-gray-100 dark:border-gray-800"
    >
      <LanguageSwitcher
        onOpen={() => {
          setThemeOpen(false);
          setFontSizeOpen(false);
        }}
        onLocaleChange={() => {
          router.refresh();
        }}
      />

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setThemeOpen((v) => !v);
              setFontSizeOpen(false);
            }}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
            title={t('quickPreferences.theme')}
          >
            {theme === 'light' && <Sun className="w-4 h-4" />}
            {theme === 'dark' && <Moon className="w-4 h-4" />}
            {theme === 'system' && <Monitor className="w-4 h-4" />}
          </button>
          {themeOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-[66] min-w-[140px]">
              <button
                onClick={() => {
                  setTheme('light');
                  setThemeOpen(false);
                  router.refresh();
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'light' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Sun className="w-4 h-4" /> {t('quickPreferences.light')}
              </button>
              <button
                onClick={() => {
                  setTheme('dark');
                  setThemeOpen(false);
                  router.refresh();
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'dark' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Moon className="w-4 h-4" /> {t('quickPreferences.dark')}
              </button>
              <button
                onClick={() => {
                  setTheme('system');
                  setThemeOpen(false);
                  router.refresh();
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'system' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Monitor className="w-4 h-4" /> {t('quickPreferences.system')}
              </button>
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setFontSizeOpen((v) => !v);
              setThemeOpen(false);
            }}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
            title={t('quickPreferences.fontSize')}
          >
            <Type className="w-4 h-4" />
          </button>
          {fontSizeOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-[66] min-w-[140px]">
              {FONT_SIZES.map((size) => (
                <button
                  key={size.value}
                  onClick={() => {
                    setFontSize(size.value);
                    setFontSizeOpen(false);
                  }}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                    fontSize === size.value &&
                      'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                  )}
                >
                  <Type className="w-4 h-4" />
                  {t(size.key)}
                </button>
              ))}
            </div>
          )}
        </div>
    </div>
  );
}
