import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, BookOpen } from 'lucide-react';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { readClassroom } from '@/lib/server/classroom-storage';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { I18nText } from '@/components/i18n-text';

export default async function InstructorClassroomsPage() {
  const session = await auth();
  if (!session?.user) redirect('/auth/signin');

  // Owner rows only
  const ownedAccess = await prisma.classroomAccess.findMany({
    where: { userId: session.user.id, assignedBy: session.user.id },
    orderBy: { assignedAt: 'desc' },
  });

  const classrooms = await Promise.all(
    ownedAccess.map(async (a) => {
      const c = await readClassroom(a.classroomId).catch(() => null);
      return c;
    }),
  );

  const resolved = classrooms.filter(Boolean);

  const studentCounts = await Promise.all(
    resolved.map(async (c) => {
      if (!c) return 0;
      return prisma.classroomAccess.count({
        where: { classroomId: c.id, NOT: { userId: session.user.id } },
      });
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white"><I18nText k="instructorClassrooms.title" fallback="Classrooms" /></h1>
        <Link
          href="/instructor/classrooms/new/step/basics"
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <I18nText k="instructorClassrooms.newClassroom" fallback="New Classroom" />
        </Link>
      </div>

      {resolved.length === 0 ? (
        <EmptyState
          title={<I18nText k="instructorClassrooms.noClassrooms" fallback="No classrooms yet" />}
          description={<I18nText k="instructorClassrooms.noClassroomsDesc" fallback="Create your first classroom to start teaching." />}
          icon={<BookOpen className="w-5 h-5" />}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3"><I18nText k="instructorClassrooms.columns.title" fallback="Title" /></th>
                <th className="px-4 py-3"><I18nText k="instructorClassrooms.columns.scenes" fallback="Scenes" /></th>
                <th className="px-4 py-3"><I18nText k="instructorClassrooms.columns.students" fallback="Students" /></th>
                <th className="px-4 py-3"><I18nText k="instructorClassrooms.columns.created" fallback="Created" /></th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {resolved.map((classroom, idx) => {
                if (!classroom) return null;
                return (
                  <tr key={classroom.id} className="hover:bg-slate-50 dark:hover:bg-white/4">
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">
                      {classroom.stage.name || classroom.id}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{classroom.scenes.length}</td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{studentCounts[idx] ?? 0}</td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">
                      {new Date(classroom.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/instructor/classrooms/${classroom.id}/overview`}
                        className="rounded-lg border border-slate-200 dark:border-white/10 px-3 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white transition-colors"
                      >
                        <I18nText k="instructorClassrooms.manage" fallback="Manage" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
