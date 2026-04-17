import { redirect } from 'next/navigation';
import { hasServerPermission } from '@/lib/auth/helpers';

export default async function AdminSystemConfigPage() {
  const canManageSystemConfig = await hasServerPermission('manage_system_config');

  if (canManageSystemConfig) {
    redirect('/admin/system-config/settings');
  } else {
    redirect('/admin/system-config/prompts');
  }
}
