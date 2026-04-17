import { auth } from '@/lib/auth/auth';
import { redirect, notFound } from 'next/navigation';
import { RoleForm } from '@/components/admin/system-config/RoleForm';
import { findRoleDefinitionById } from '@/lib/admin/role-definitions';
import { hasServerPermission } from '@/lib/auth/helpers';

export default async function EditRolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/');
  }

  const canEditRoles = await hasServerPermission('edit_roles');
  if (!canEditRoles) {
    redirect('/admin/roles');
  }

  const role = await findRoleDefinitionById(id);

  if (!role) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-2 text-sm text-slate-400">
        <a href="/admin/roles" className="hover:text-white">Roles</a>
        <span>/</span>
        <span>{role.displayName}</span>
      </nav>

      <div>
        <h1 className="text-2xl font-bold text-white">{role.displayName}</h1>
        <p className="mt-1 text-sm text-slate-400">{role.description}</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <RoleForm initialRole={role} />
      </div>
    </div>
  );
}