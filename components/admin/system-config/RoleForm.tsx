'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { PermissionMatrix } from './PermissionMatrix';

interface RoleFormProps {
  initialRole?: {
    id: string;
    name: string;
    displayName: string;
    description: string | null;
    permissions: any;
    isBuiltIn: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
}

export function RoleForm({ initialRole }: RoleFormProps) {
  const router = useRouter();
  const initialPermissions = initialRole?.permissions
    ? (Array.isArray(initialRole.permissions)
        ? initialRole.permissions
        : Object.keys(initialRole.permissions))
    : [];

  const [form, setForm] = useState({
    name: initialRole?.name ?? '',
    displayName: initialRole?.displayName ?? '',
    description: initialRole?.description ?? '',
    permissions: initialPermissions,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});

    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.displayName.trim()) errs.displayName = 'Display name is required';
    if (form.permissions.length === 0) errs.permissions = 'At least one permission required';

    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }

    setSubmitting(true);

    try {
      const method = initialRole ? 'PATCH' : 'POST';
      const url = initialRole
        ? `/api/admin/system-config/roles/${initialRole.id}`
        : '/api/admin/system-config/roles';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          displayName: form.displayName.trim(),
          description: form.description.trim(),
          permissions: form.permissions,
        }),
      });

      const data = await res.json();
      setSubmitting(false);

      if (!res.ok) {
        setErrors({ submit: data.error ?? 'Failed to save role' });
      } else {
        router.push('/admin/roles');
        router.refresh();
      }
    } catch (err) {
      setSubmitting(false);
      setErrors({ submit: 'An error occurred' });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {errors.submit && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-400 text-sm">{errors.submit}</div>
      )}

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1.5">Role name (lowercase, underscores only)</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          disabled={!!initialRole}
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
          placeholder="custom_role"
        />
        {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1.5">Display name</label>
        <input
          type="text"
          value={form.displayName}
          onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          placeholder="Custom Role"
        />
        {errors.displayName && <p className="text-red-400 text-xs mt-1">{errors.displayName}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1.5">Description</label>
        <textarea
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
          rows={3}
          placeholder="Optional description"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-3">Permissions</label>
        <PermissionMatrix
          selectedPermissions={form.permissions}
          onChange={(perms) => setForm((f) => ({ ...f, permissions: perms }))}
        />
        {errors.permissions && <p className="text-red-400 text-xs mt-2">{errors.permissions}</p>}
      </div>

      <div className="flex gap-3 pt-4">
        <Button
          type="submit"
          disabled={submitting}
          className="bg-purple-600 hover:bg-purple-700 text-white gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {initialRole ? 'Update role' : 'Create role'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/admin/roles')}
          className="border-white/10 text-slate-300"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
