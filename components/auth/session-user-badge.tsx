'use client';

import { useCallback, useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';

interface SessionUserView {
  nick: string | null;
  username: string | null;
  userno: string | null;
  role: string;
  rolename: string | null;
  schoolName: string | null;
  className: string | null;
  headimg: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  '0': '管理员',
  '3': '教师',
  '4': '学生',
};

/**
 * Small floating identity chip for the courseware page: who is watching, and
 * a logout affordance. Renders nothing when there is no SSO session (admins
 * previewing via the access code, or SSO not configured).
 */
export function SessionUserBadge() {
  const [user, setUser] = useState<SessionUserView | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { headers: { accept: 'application/json' } })
      .then((res) => res.json())
      .then((data: { user: SessionUserView | null }) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.reload();
    }
  }, []);

  if (!user) return null;

  const name = user.nick || user.username || user.userno || '用户';
  const roleLabel = ROLE_LABELS[user.role] ?? (user.rolename || '');

  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-2 rounded-full bg-white/85 dark:bg-gray-900/85 backdrop-blur border border-gray-200/70 dark:border-gray-700/70 pl-1 pr-2 py-1 shadow-sm">
      {user.headimg ? (
        <img
          src={user.headimg}
          alt={name}
          className="w-6 h-6 rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-300 flex items-center justify-center text-[11px] font-semibold">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="text-xs text-gray-700 dark:text-gray-200 max-w-32 truncate">{name}</span>
      {roleLabel && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
          {roleLabel}
        </span>
      )}
      <button
        type="button"
        onClick={() => void logout()}
        disabled={loggingOut}
        title="退出登录"
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
