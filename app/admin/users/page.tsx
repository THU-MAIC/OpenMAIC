'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Plus, Search, Pencil, Trash2, Shield, BookOpen, Users, Loader2, X, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Role } from '@prisma/client';
import { useI18n } from '@/lib/hooks/use-i18n';
import { adminWizardsEnabled } from '@/lib/admin/feature-flags';

interface UserRow {
  id: string;
  name: string | null;
  email: string;
  studentId: string | null;
  role: Role;
  isActive: boolean;
  consentGiven: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  _count: { classroomAccess: number };
}

const ROLE_COLORS: Record<Role, string> = {
  ADMIN: 'bg-red-500/15 text-red-400',
  INSTRUCTOR: 'bg-emerald-500/15 text-emerald-400',
  STUDENT: 'bg-blue-500/15 text-blue-400',
};

export default function UsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const roleLabels: Record<Role, string> = {
    ADMIN: t('adminUsers.roles.admin'),
    INSTRUCTOR: t('adminUsers.roles.instructor'),
    STUDENT: t('adminUsers.roles.student'),
  };

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (roleFilter) params.set('role', roleFilter);
    const res = await fetch(`/api/admin/users?${params}`);
    const data = await res.json();
    setUsers(data.users ?? []);
    setLoading(false);
  }, [search, roleFilter]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  async function deleteUser(id: string, name: string | null) {
    if (!confirm(t('adminUsers.deleteConfirm', { name: name ?? id }))) return;
    await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    void fetchUsers();
  }

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('adminUsers.title')}</h1>
        {adminWizardsEnabled ? (
          <Button asChild className="bg-purple-600 hover:bg-purple-700 text-white gap-2">
            <Link href="/admin/users/new/identity">
              <Plus className="w-4 h-4" /> {t('adminUsers.addUser')}
            </Link>
          </Button>
        ) : (
          <Button
            onClick={() => { setEditing(null); setShowForm(true); }}
            className="bg-purple-600 hover:bg-purple-700 text-white gap-2"
          >
            <Plus className="w-4 h-4" /> {t('adminUsers.addUser')}
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder={t('adminUsers.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as Role | '')}
          className="px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
        >
          <option value="">{t('adminUsers.allRoles')}</option>
          <option value="ADMIN">{t('adminUsers.roles.admin')}</option>
          <option value="INSTRUCTOR">{t('adminUsers.roles.instructor')}</option>
          <option value="STUDENT">{t('adminUsers.roles.student')}</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-500">
            <Users className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">{t('adminUsers.noUsers')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-white/5">
                {[
                  t('adminUsers.columns.name'),
                  t('adminUsers.columns.email'),
                  t('adminUsers.columns.studentId'),
                  t('adminUsers.columns.role'),
                  t('adminUsers.columns.status'),
                  t('adminUsers.columns.classrooms'),
                  t('adminUsers.columns.lastLogin'),
                  '',
                ].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-slate-500 dark:text-slate-400 font-medium text-xs uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-white/3 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/admin/users/${u.id}`} className="font-medium text-slate-900 dark:text-white hover:text-primary">
                      {u.name ?? '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{u.email}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{u.studentId ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[u.role]}`}>
                      {u.role === 'ADMIN' && <Shield className="w-3 h-3" />}
                      {u.role === 'INSTRUCTOR' && <BookOpen className="w-3 h-3" />}
                      {roleLabels[u.role]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${u.isActive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                      {u.isActive ? t('adminUsers.status.active') : t('adminUsers.status.disabled')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{u._count.classroomAccess}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : t('adminUsers.never')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setEditing(u); setShowForm(true); }}
                        className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
                        title={t('adminUsers.actions.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteUser(u.id, u.name)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-500 dark:text-slate-400 hover:text-red-400 transition-colors"
                        title={t('adminUsers.actions.delete')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <UserFormModal
          user={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); void fetchUsers(); }}
        />
      )}
    </div>
  );
}

// ---- User Form Modal --------------------------------------------------------

interface FormState {
  name: string;
  email: string;
  studentId: string;
  password: string;
  role: Role;
  isActive: boolean;
}

function UserFormModal({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>({
    name: user?.name ?? '',
    email: user?.email ?? '',
    studentId: user?.studentId ?? '',
    password: '',
    role: user?.role ?? 'STUDENT',
    isActive: user?.isActive ?? true,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = t('adminUsers.validation.nameRequired');
    if (!form.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) errs.email = t('adminUsers.validation.emailRequired');
    if (form.role === 'STUDENT' && !form.studentId.trim()) errs.studentId = t('adminUsers.validation.studentIdRequired');
    if (!user && form.password.length < 10) errs.password = t('adminUsers.validation.passwordMin');
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSaving(true);
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      email: form.email.trim(),
      studentId: form.role === 'STUDENT' ? form.studentId.trim() : '',
      role: form.role,
      isActive: form.isActive,
    };
    if (!user || form.password) body.password = form.password;

    const res = user
      ? await fetch(`/api/admin/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setErrors({ submit: d.error ?? t('adminUsers.validation.saveFailed') });
    } else {
      onSaved();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-slate-900 dark:text-white font-semibold text-lg">{user ? t('adminUsers.modal.editTitle') : t('adminUsers.modal.addTitle')}</h2>
          <button onClick={onClose} className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {errors.submit && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {errors.submit}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 dark:text-slate-300 mb-1">{t('adminUsers.modal.fullName')} *</label>
            <input type="text" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            {errors.name && <p className="text-red-400 text-xs mt-0.5">{errors.name}</p>}
          </div>

          <div>
            <label className="block text-sm text-slate-700 dark:text-slate-300 mb-1">{t('adminUsers.columns.email')} *</label>
            <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            {errors.email && <p className="text-red-400 text-xs mt-0.5">{errors.email}</p>}
          </div>

          <div>
            <label className="block text-sm text-slate-700 dark:text-slate-300 mb-1">{t('adminUsers.columns.studentId')} {form.role === 'STUDENT' ? '*' : `(${t('adminUsers.modal.optional')})`}</label>
            <input type="text" value={form.studentId} onChange={(e) => setForm(f => ({ ...f, studentId: e.target.value }))}
              placeholder={form.role === 'STUDENT' ? t('adminUsers.modal.studentIdExample') : t('adminUsers.modal.studentIdNotRequired')}
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
            {errors.studentId && <p className="text-red-400 text-xs mt-0.5">{errors.studentId}</p>}
          </div>

          <div>
            <label className="block text-sm text-slate-700 dark:text-slate-300 mb-1">{user ? t('adminUsers.modal.newPassword') : t('adminUsers.modal.passwordRequired')}</label>
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} value={form.password}
                onChange={(e) => setForm(f => ({ ...f, password: e.target.value }))}
                className="w-full px-3 py-2 pr-9 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
              <button type="button" onClick={() => setShowPassword(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.password && <p className="text-red-400 text-xs mt-0.5">{errors.password}</p>}
          </div>

          <div>
            <label className="block text-sm text-slate-700 dark:text-slate-300 mb-1">{t('adminUsers.columns.role')}</label>
            <select value={form.role} onChange={(e) => setForm(f => ({ ...f, role: e.target.value as Role }))}
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500">
              <option value="STUDENT">{t('adminUsers.roles.student')}</option>
              <option value="INSTRUCTOR">{t('adminUsers.roles.instructor')}</option>
              <option value="ADMIN">{t('adminUsers.roles.admin')}</option>
            </select>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm(f => ({ ...f, isActive: e.target.checked }))}
              className="w-4 h-4 rounded accent-purple-500" />
            <span className="text-sm text-slate-700 dark:text-slate-300">{t('adminUsers.modal.accountActive')}</span>
          </label>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 border-slate-300 dark:border-white/10 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white">
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : user ? t('adminUsers.modal.saveChanges') : t('adminUsers.modal.createUser')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
