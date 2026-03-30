'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { LogOut, KeyRound, Users } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

export function UserMenu() {
  const { data: session } = useSession();
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    },
    [open],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open, handleClickOutside]);

  if (!session?.user) return null;

  const isAdmin = (session.user as { role?: string }).role === 'admin';

  const initials = (session.user.name || session.user.email || '?')
    .split(/[\s@]/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 rounded-full text-xs font-medium transition-all',
          'text-gray-500 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm',
        )}
      >
        <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">
          {initials}
        </span>
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[180px]">
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
              {session.user.name || session.user.email}
            </p>
            {session.user.name && (
              <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                {session.user.email}
              </p>
            )}
          </div>
          {isAdmin && (
            <button
              onClick={() => {
                setOpen(false);
                router.push('/dashboard/users');
              }}
              className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2 text-gray-600 dark:text-gray-400"
            >
              <Users className="w-3.5 h-3.5" />
              {t('auth.users')}
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false);
              router.push('/dashboard/settings');
            }}
            className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2 text-gray-600 dark:text-gray-400"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {t('auth.changePassword')}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              signOut({ callbackUrl: '/login' });
            }}
            className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2 text-gray-600 dark:text-gray-400"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t('auth.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
