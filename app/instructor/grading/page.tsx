import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ClipboardList } from 'lucide-react';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { readClassroom } from '@/lib/server/classroom-storage';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { I18nText } from '@/components/i18n-text';

export default async function InstructorGradingPage() {
  const session = await auth();
  if (!session?.user) redirect('/auth/signin');

  const ownedAccess = await prisma.classroomAccess.findMany({
    where: {
      userId: session.user.id,
      assignedBy: session.user.id,
    },
    orderBy: { assignedAt: 'desc' },
    take: 100,
  });

  const classrooms = await Promise.all(
    ownedAccess.map(async (access) => {
      const classroom = await readClassroom(access.classroomId).catch(() => null);
      if (!classroom) return null;

      const [resultCount, studentCount] = await Promise.all([
        prisma.quizResult.count({ where: { classroomId: classroom.id } }),
        prisma.classroomAccess.count({ where: { classroomId: classroom.id, NOT: { userId: session.user.id } } }),
      ]);

      return {
        id: classroom.id,
        name: classroom.stage.name || classroom.id,
        resultCount,
        studentCount,
      };
    }),
  );

  const resolved = classrooms.filter(Boolean);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white"><I18nText k="instructorGrading.title" fallback="Grading Management" /></h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400"><I18nText k="instructorGrading.subtitle" fallback="Review classroom gradebooks and drill into student scoring details." /></p>
      </div>

      {resolved.length === 0 ? (
        <EmptyState
          title={<I18nText k="instructorGrading.noClassrooms" fallback="No classrooms available" />}
          description={<I18nText k="instructorGrading.noClassroomsDesc" fallback="Create a classroom first. Gradebooks will appear once students submit quizzes." />}
          icon={<ClipboardList className="w-5 h-5" />}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3"><I18nText k="instructorGrading.columns.classroom" fallback="Classroom" /></th>
                <th className="px-4 py-3"><I18nText k="instructorGrading.columns.students" fallback="Students" /></th>
                <th className="px-4 py-3"><I18nText k="instructorGrading.columns.quizResults" fallback="Quiz Results" /></th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {resolved.map((classroom) => {
                if (!classroom) return null;
                return (
                  <tr key={classroom.id} className="hover:bg-slate-50 dark:hover:bg-white/4">
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{classroom.name}</td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{classroom.studentCount}</td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{classroom.resultCount}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/instructor/classrooms/${classroom.id}/grades`}
                        className="rounded-lg border border-slate-200 dark:border-white/10 px-3 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white transition-colors"
                      >
                        <I18nText k="instructorGrading.openGradebook" fallback="Open Gradebook" />
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
