'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Plus, Loader2, Trash2, Edit2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { useI18n } from '@/lib/hooks/use-i18n';

interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isBuiltIn: boolean;
  permissions: string[];
}

export default function AdminRolesPage() {
  const { t } = useI18n();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    const res = await fetch('/api/admin/system-config/roles');
    if (!res.ok) {
      setRoles([]);
      setLoading(false);
      setFetchError(res.status === 403 ? t('adminRoles.accessDenied') : t('adminRoles.loadFailed'));
      return;
    }
    const data = await res.json();
    setRoles(data.roles ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchRoles();
  }, [fetchRoles]);

  async function deleteRole(id: string) {
    if (!confirm(t('adminRoles.deleteConfirm'))) return;
    setDeleting(id);
    const res = await fetch(`/api/admin/system-config/roles/${id}`, { method: 'DELETE' });
    setDeleting(null);
    if (res.ok) {
      void fetchRoles();
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('adminRoles.title')}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('adminRoles.subtitle')}</p>
        </div>
        <Button asChild className="gap-2 bg-purple-600 hover:bg-purple-700 text-white">
          <Link href="/admin/roles/new">
            <Plus className="h-4 w-4" />
            {t('adminRoles.newRole')}
          </Link>
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-purple-400" />
        </div>
      ) : fetchError ? (
        <EmptyState title={t('adminRoles.accessDeniedTitle')} description={fetchError} />
      ) : roles.length === 0 ? (
        <EmptyState title={t('adminRoles.noRoles')} description={t('adminRoles.noRolesDesc')} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-white/10">
                {[t('adminRoles.columns.name'), t('adminRoles.columns.displayName'), t('adminRoles.columns.type'), t('adminRoles.columns.permissions'), ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {roles.map((role) => (
                <tr key={role.id} className="hover:bg-slate-50 dark:hover:bg-white/5">
                  <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-200">{role.name}</td>
                  <td className="px-4 py-3 text-slate-900 dark:text-white">{role.displayName}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                        role.isBuiltIn ? 'bg-slate-100 dark:bg-slate-500/15 text-slate-600 dark:text-slate-300' : 'bg-purple-100 dark:bg-purple-500/15 text-purple-700 dark:text-purple-300'
                      }`}
                    >
                      {role.isBuiltIn ? t('adminRoles.builtIn') : t('adminRoles.custom')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{role.permissions.length} {t('adminRoles.permissions')}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/admin/roles/${role.id}`}
                        className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
                        title={t('adminRoles.manageRole')}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </Link>
                      {!role.isBuiltIn && (
                        <button
                          onClick={() => deleteRole(role.id)}
                          disabled={deleting === role.id}
                          className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                          title={t('adminRoles.deleteRole')}
                        >
                          {deleting === role.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}