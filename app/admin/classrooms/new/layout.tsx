import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { adminWizardsEnabled } from '@/lib/admin/feature-flags';

export default function ClassroomWizardLayout({ children }: { children: ReactNode }) {
  if (!adminWizardsEnabled) {
    redirect('/admin/classrooms');
  }
  return <div>{children}</div>;
}
