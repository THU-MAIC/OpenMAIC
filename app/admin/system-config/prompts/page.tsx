import { hasServerPermission, requirePermissions } from '@/lib/auth/helpers';
import { redirect } from 'next/navigation';
import { PromptList } from '@/components/admin/system-config/PromptList';

export default async function AdminPromptsPage() {
  try {
    await requirePermissions('view_prompts');
  } catch {
    redirect('/');
  }

  const [canCreate, canEdit, canDelete] = await Promise.all([
    hasServerPermission('create_prompts'),
    hasServerPermission('edit_prompts'),
    hasServerPermission('delete_prompts'),
  ]);

  return (
    <div className="space-y-6">
      <PromptList
        canCreate={canCreate}
        canEdit={canEdit}
        canDelete={canDelete}
        canExport={true}
        canImport={canCreate && canEdit}
      />
    </div>
  );
}
