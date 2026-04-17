'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Settings, Sun, Moon, Monitor, Type } from 'lucide-react';
import { useTheme } from '@/lib/hooks/use-theme';
import { cn } from '@/lib/utils';

const FONT_SIZES = [
  { label: 'Small', value: 14 },
  { label: 'Default', value: 16 },
  { label: 'Large', value: 18 },
] as const;

const FONT_SIZE_KEY = 'openmaic-ui-font-size';

function applyRootFontSize(size: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${size}px`;
}

export function PreferencesFab() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { theme, setTheme } = useTheme();

  const [open, setOpen] = useState(false);
  const [fontSize, setFontSize] = useState<number>(16);

  const ref = useRef<HTMLDivElement>(null);

  const isSignInPage = pathname?.startsWith('/auth/signin');
  const isClassroomPage = pathname?.startsWith('/classroom/');
  const isAdmin = session?.user?.role === 'ADMIN';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(FONT_SIZE_KEY);
    const parsed = saved ? Number(saved) : 16;
    const next = Number.isFinite(parsed) && [14, 16, 18].includes(parsed) ? parsed : 16;
    setFontSize(next);
    applyRootFontSize(next);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    applyRootFontSize(fontSize);
    window.localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  if (status === 'loading') return null;
  if (!session?.user) return null;
  if (isSignInPage) return null;
  if (isClassroomPage) return null;

  return (
    <>
      <div className="fixed top-4 right-4 z-[70]" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="h-10 w-10 rounded-full border border-gray-100/60 bg-white/70 text-gray-500 shadow-sm backdrop-blur-md transition-all hover:bg-white hover:text-gray-800 hover:shadow-md dark:border-gray-700/70 dark:bg-gray-800/70 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          aria-label="Open preferences"
          title="Preferences"
        >
          <Settings className="mx-auto h-4 w-4" />
        </button>

        {open && (
          <div className="absolute top-14 right-0 w-72 rounded-2xl border border-white/10 bg-slate-900/95 p-4 text-white shadow-2xl backdrop-blur-md">
            <p className="mb-3 text-sm font-semibold">Preferences</p>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-slate-400">Theme</p>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setTheme('light')}
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs transition-colors',
                    theme === 'light'
                      ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10',
                  )}
                >
                  <Sun className="h-3.5 w-3.5" /> Light
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('dark')}
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs transition-colors',
                    theme === 'dark'
                      ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10',
                  )}
                >
                  <Moon className="h-3.5 w-3.5" /> Dark
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('system')}
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs transition-colors',
                    theme === 'system'
                      ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10',
                  )}
                >
                  <Monitor className="h-3.5 w-3.5" /> System
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <p className="text-xs uppercase tracking-wide text-slate-400">Size</p>
              <div className="grid grid-cols-3 gap-2">
                {FONT_SIZES.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    onClick={() => setFontSize(size.value)}
                    className={cn(
                      'inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs transition-colors',
                      fontSize === size.value
                        ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10',
                    )}
                  >
                    <Type className="h-3.5 w-3.5" /> {size.label}
                  </button>
                ))}
              </div>
            </div>

            {isAdmin && (
              <div className="mt-4 border-t border-white/10 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.push('/admin/system-config/settings');
                  }}
                  className="w-full rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-left text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
                >
                  Open General Settings
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
