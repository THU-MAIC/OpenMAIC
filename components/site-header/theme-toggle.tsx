'use client';

import { useState, useRef, useEffect } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/lib/hooks/use-theme';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import '@/components/workbench/workspace/pro-popover-scope.css';

const OPTIONS = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const ActiveIcon = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-8 inline-flex items-center justify-center rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-gray-100 transition-all"
        aria-label="Theme"
      >
        <ActiveIcon className="w-4 h-4" />
      </button>
      {open && (
        <div className="pro-theme-popover absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[140px]">
          {OPTIONS.map(({ value, icon: Icon }) => (
            <button
              key={value}
              onClick={() => {
                setTheme(value);
                setOpen(false);
              }}
              className={cn(
                'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                theme === value &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Icon className="w-4 h-4" />
              {t(`settings.themeOptions.${value}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
