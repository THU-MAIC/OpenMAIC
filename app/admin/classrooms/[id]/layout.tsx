import type { ReactNode } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/auth/auth';
import { redirect } from 'next/navigation';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { DetailTabNav } from '@/components/admin/common/DetailTabNav';
import { I18nText } from '@/components/i18n-text';

export default async function AdminClassroomDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'INSTRUCTOR')) {
    redirect('/');
  }

  const { id } = await params;
  if (!isValidClassroomId(id)) redirect('/admin/classrooms');

  const tabs = [
    { label: <I18nText k="classroomDetailNav.overview" fallback="Overview" />, href: `/admin/classrooms/${id}/overview` },
    { label: <I18nText k="classroomDetailNav.students" fallback="Students" />, href: `/admin/classrooms/${id}/students` },
    { label: <I18nText k="classroomDetailNav.content" fallback="Content" />, href: `/admin/classrooms/${id}/content` },
    { label: <I18nText k="classroomDetailNav.settings" fallback="Settings" />, href: `/admin/classrooms/${id}/settings` },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Link href="/admin/classrooms" className="hover:text-white"><I18nText k="classroomDetailNav.classrooms" fallback="Classrooms" /></Link>
        <span>/</span>
        <span className="font-mono text-xs text-slate-300">{id}</span>
      </div>

      <DetailTabNav tabs={tabs} />

      {children}
    </div>
  );
}
