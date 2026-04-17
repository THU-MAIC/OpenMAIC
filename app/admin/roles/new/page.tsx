import { requirePermissions } from '@/lib/auth/helpers';
import { redirect } from 'next/navigation';
import { RoleForm } from '@/components/admin/system-config/RoleForm';

export default async function NewRolePage() {
  try {
    await requirePermissions('create_roles');
  } catch {
    redirect('/');
  }

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-2 text-sm text-slate-400">
        <a href="/admin/roles" className="hover:text-white">Roles</a>
        <span>/</span>
        <span>Create new</span>
      </nav>

      <div>
        <h1 className="text-2xl font-bold text-white">Create new role</h1>
        <p className="mt-1 text-sm text-slate-400">Define permissions for the new role</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <RoleForm />
      </div>
    </div>
  );
}