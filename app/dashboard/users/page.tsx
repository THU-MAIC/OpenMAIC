'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { ArrowLeft, Trash2, ShieldCheck, UserCircle, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
}

export default function UsersPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { t } = useI18n();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);

  const isAdmin = (session?.user as { role?: string } | undefined)?.role === 'admin';

  const fetchUsers = useCallback(async () => {
    const res = await fetch('/api/admin/users');
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (status === 'loading') return;
    if (!isAdmin) {
      router.replace('/dashboard');
      return;
    }
    fetchUsers();
  }, [status, isAdmin, fetchUsers, router]);

  const toggleRole = async (user: UserRow) => {
    const newRole = user.role === 'admin' ? 'teacher' : 'admin';
    setActionId(user.id);
    await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: user.id, role: newRole }),
    });
    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)));
    setActionId(null);
  };

  const deleteUser = async (user: UserRow) => {
    if (!confirm(t('auth.deleteUserConfirm'))) return;
    setActionId(user.id);
    await fetch('/api/admin/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: user.id }),
    });
    setUsers((prev) => prev.filter((u) => u.id !== user.id));
    setActionId(null);
  };

  if (status === 'loading' || (status === 'authenticated' && !isAdmin)) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => router.push('/dashboard')}
            className="p-2 rounded-lg hover:bg-white dark:hover:bg-gray-800 transition-colors text-gray-500"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-200">
            {t('auth.userManagement')}
          </h1>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : users.length === 0 ? (
          <p className="text-center text-gray-400 py-16">{t('auth.noUsers')}</p>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t('auth.userName')}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t('auth.userEmail')}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t('auth.userRole')}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t('auth.userCreatedAt')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.map((user, i) => {
                  const isSelf = user.id === session?.user?.id;
                  const busy = actionId === user.id;
                  return (
                    <motion.tr
                      key={user.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                      className="border-b border-gray-100 dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700/30"
                    >
                      <td className="px-4 py-3 text-gray-800 dark:text-gray-200 font-medium">
                        {user.name || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{user.email}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            user.role === 'admin'
                              ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          }`}
                        >
                          {user.role === 'admin' ? (
                            <ShieldCheck className="w-3 h-3" />
                          ) : (
                            <UserCircle className="w-3 h-3" />
                          )}
                          {user.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleTeacher')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        {!isSelf && (
                          <div className="flex items-center gap-2 justify-end">
                            <button
                              onClick={() => toggleRole(user)}
                              disabled={busy}
                              className="px-2.5 py-1 rounded-lg text-xs border border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-400 disabled:opacity-50"
                            >
                              {busy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : user.role === 'admin' ? (
                                t('auth.roleTeacher')
                              ) : (
                                t('auth.roleAdmin')
                              )}
                            </button>
                            <button
                              onClick={() => deleteUser(user)}
                              disabled={busy}
                              className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-red-400 hover:text-red-600 transition-colors disabled:opacity-50"
                            >
                              {busy ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        )}
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
