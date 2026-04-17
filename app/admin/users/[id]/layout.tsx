import type { ReactNode } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/auth/auth';
import { redirect } from 'next/navigation';
import { DetailTabNav } from '@/components/admin/common/DetailTabNav';
import { I18nText } from '@/components/i18n-text';

export default async function AdminUserDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/');
  }

  const { id } = await params;

  const tabs = [
    { label: <I18nText k="adminUserDetailNav.overview" fallback="Overview" />, href: `/admin/users/${id}` },
    { label: <I18nText k="adminUserDetailNav.activity" fallback="Activity" />, href: `/admin/users/${id}/activity` },
    { label: <I18nText k="adminUserDetailNav.classrooms" fallback="Classrooms" />, href: `/admin/users/${id}/classrooms` },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Link href="/admin/users" className="hover:text-white"><I18nText k="adminUserDetailNav.users" fallback="Users" /></Link>
        <span>/</span>
        <span className="font-mono text-xs text-slate-300">{id}</span>
      </div>

      <DetailTabNav tabs={tabs} />

      {children}
    </div>
  );
}
