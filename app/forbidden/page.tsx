'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, ShieldX } from 'lucide-react';

interface UserView {
  nick: string | null;
  username: string | null;
  userno: string | null;
  role: string;
  rolename: string | null;
  schoolName: string | null;
  className: string | null;
  headimg: string | null;
}

export default function ForbiddenPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserView | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { headers: { accept: 'application/json' } })
      .then((res) => res.json())
      .then((data: { user: UserView | null }) => {
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
      router.replace('/login');
    }
  }, [router]);

  const displayName = user?.nick || user?.username || user?.userno || '当前账号';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-950 dark:to-gray-900 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-800 p-8">
        <div className="flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center mb-4 shadow-lg shadow-amber-200/50">
            <ShieldX className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">无权访问</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 leading-relaxed">
            课件生成工作台仅对管理员开放。
            {user ? `${displayName}，请使用课件链接进入观看。` : '请使用课件链接进入观看。'}
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-2">
          {user && (
            <button
              type="button"
              onClick={() => void logout()}
              disabled={loggingOut}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              退出登录
            </button>
          )}
          <button
            type="button"
            onClick={() => router.replace('/login')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            返回登录页
          </button>
        </div>
      </div>
    </div>
  );
}
