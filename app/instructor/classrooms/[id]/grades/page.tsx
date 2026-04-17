import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { BookOpen } from 'lucide-react';
import { I18nText } from '@/components/i18n-text';

interface QuizResultRow {
  id: string;
  studentDbUserId: string | null;
  studentLabel: string;
  sceneId: string;
  sceneTitle: string;
  score: number;
  maxScore: number;
  gradedAt: Date;
}

export default async function InstructorGradesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: classroomId } = await params;
  const session = await auth();
  if (!session?.user) redirect('/auth/signin');

  if (!isValidClassroomId(classroomId)) redirect('/instructor/classrooms');

  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) redirect('/instructor/classrooms');
  }

  const results: QuizResultRow[] = await prisma.quizResult.findMany({
    where: { classroomId },
    select: {
      id: true,
      studentDbUserId: true,
      studentLabel: true,
      sceneId: true,
      sceneTitle: true,
      score: true,
      maxScore: true,
      gradedAt: true,
    },
    orderBy: { gradedAt: 'desc' },
  });

  if (results.length === 0) {
    return (
      <EmptyState
        title={<I18nText k="instructorGradebook.noQuizResults" fallback="No quiz results yet" />}
        description={<I18nText k="instructorGradebook.noQuizResultsDesc" fallback="Results will appear here once students complete quizzes in this classroom." />}
        icon={<BookOpen className="w-5 h-5" />}
      />
    );
  }

  // Build matrix: rows = unique students, columns = unique scenes
  const studentMap = new Map<string, { label: string; userId: string | null }>();
  const sceneMap = new Map<string, string>(); // sceneId → sceneTitle

  for (const r of results) {
    const key = r.studentDbUserId ?? `local:${r.studentLabel}`;
    if (!studentMap.has(key)) {
      studentMap.set(key, { label: r.studentLabel, userId: r.studentDbUserId });
    }
    if (!sceneMap.has(r.sceneId)) {
      sceneMap.set(r.sceneId, r.sceneTitle);
    }
  }

  const students = Array.from(studentMap.entries()); // [key, {label, userId}]
  const scenes = Array.from(sceneMap.entries()); // [sceneId, title]

  // Index: studentKey → sceneId → latest QuizResult
  const index = new Map<string, Map<string, QuizResultRow>>();
  for (const r of results) {
    const key = r.studentDbUserId ?? `local:${r.studentLabel}`;
    if (!index.has(key)) index.set(key, new Map());
    const existing = index.get(key)!.get(r.sceneId);
    // Keep the most recent (results are already ordered desc)
    if (!existing) index.get(key)!.set(r.sceneId, r);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white"><I18nText k="instructorGradebook.title" fallback="Gradebook" /></h2>
        <a
          href={`/api/instructor/classrooms/${classroomId}/grades/export`}
          download="grades.csv"
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          <I18nText k="instructorGradebook.exportCsv" fallback="Export CSV" />
        </a>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3 sticky left-0 bg-slate-900 z-10"><I18nText k="instructorGradebook.student" fallback="Student" /></th>
              {scenes.map(([sceneId, title]) => (
                <th key={sceneId} className="px-3 py-3 text-center min-w-[80px]">
                  <span className="block truncate max-w-[120px]" title={title}>{title}</span>
                </th>
              ))}
              <th className="px-3 py-3 text-center"><I18nText k="instructorGradebook.total" fallback="Total" /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {students.map(([key, { label, userId }]) => {
              const studentResults = index.get(key) ?? new Map<string, QuizResultRow>();
              const total = Array.from(studentResults.values()).reduce((s, r) => s + r.score, 0);
              const maxTotal = Array.from(studentResults.values()).reduce((s, r) => s + r.maxScore, 0);

              return (
                <tr key={key} className="hover:bg-white/4">
                  <td className="px-4 py-3 sticky left-0 bg-slate-900 font-medium text-white">
                    {userId ? (
                      <Link
                        href={`/instructor/classrooms/${classroomId}/grades/${userId}`}
                        className="hover:text-indigo-400 transition-colors"
                      >
                        {label}
                      </Link>
                    ) : (
                      <span>{label}</span>
                    )}
                  </td>
                  {scenes.map(([sceneId]) => {
                    const r = studentResults.get(sceneId);
                    return (
                      <td key={sceneId} className="px-3 py-3 text-center text-slate-300">
                        {r ? (
                          <span className={r.score === r.maxScore ? 'text-emerald-400 font-medium' : ''}>
                            {r.score}/{r.maxScore}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-3 text-center font-medium text-white">
                    {maxTotal > 0 ? `${total}/${maxTotal}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
