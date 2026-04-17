import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { adminWizardsEnabled } from '@/lib/admin/feature-flags';

export default function AdminUserWizardLayout({ children }: { children: ReactNode }) {
  if (!adminWizardsEnabled) {
    redirect('/admin/users');
  }
  return <div>{children}</div>;
}
