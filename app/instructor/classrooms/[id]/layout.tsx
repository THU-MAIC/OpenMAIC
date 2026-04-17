import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { isValidClassroomId, readClassroom } from '@/lib/server/classroom-storage';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { DetailTabNav } from '@/components/admin/common/DetailTabNav';
import { I18nText } from '@/components/i18n-text';

export default async function InstructorClassroomDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/auth/signin');

  const { id } = await params;

  if (!isValidClassroomId(id)) redirect('/instructor/classrooms');

  // Security: only owner or ADMIN can access this classroom management section
  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, id);
    if (!owns) redirect('/instructor/classrooms');
  }

  const classroom = await readClassroom(id);
  if (!classroom) notFound();

  const title = classroom.stage.name || id;

  const tabs = [
    { label: <I18nText k="classroomDetailNav.overview" fallback="Overview" />, href: `/instructor/classrooms/${id}/overview` },
    { label: <I18nText k="classroomDetailNav.students" fallback="Students" />, href: `/instructor/classrooms/${id}/students` },
    { label: <I18nText k="classroomDetailNav.grades" fallback="Grades" />, href: `/instructor/classrooms/${id}/grades` },
    { label: <I18nText k="classroomDetailNav.content" fallback="Content" />, href: `/instructor/classrooms/${id}/content` },
    { label: <I18nText k="classroomDetailNav.settings" fallback="Settings" />, href: `/instructor/classrooms/${id}/settings` },
  ];

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Link href="/instructor/classrooms" className="hover:text-white transition-colors">
          <I18nText k="classroomDetailNav.classrooms" fallback="Classrooms" />
        </Link>
        <span>/</span>
        <span className="font-medium text-slate-200 truncate max-w-xs">{title}</span>
      </div>

      <DetailTabNav tabs={tabs} />

      {children}
    </div>
  );
}
