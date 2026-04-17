import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Mail, User, BookOpen } from 'lucide-react';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { EmptyState } from '@/components/admin/common/EmptyState';

export default async function InstructorStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  const { id: classroomId, studentId } = await params;
  const session = await auth();
  if (!session?.user) redirect('/auth/signin');

  if (!isValidClassroomId(classroomId)) redirect(`/instructor/classrooms`);

  // Security: verify caller owns the classroom
  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) redirect(`/instructor/classrooms`);
  }

  // Fetch the access record to confirm student is enrolled
  const access = await prisma.classroomAccess.findUnique({
    where: { userId_classroomId: { userId: studentId, classroomId } },
    include: { user: { select: { id: true, name: true, email: true, studentId: true, role: true, createdAt: true } } },
  });

  if (!access) notFound();

  const { user } = access;

  // Fetch quiz results
  const quizResults = await prisma.quizResult
    .findMany({
      where: { classroomId, studentDbUserId: studentId },
      orderBy: { gradedAt: 'desc' },
    })
    .catch(() => []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/instructor/classrooms/${classroomId}/students`}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to roster
        </Link>
      </div>

      {/* Student detail card */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-6 space-y-4">
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <User className="w-5 h-5 text-indigo-400" />
          {user.name ?? '(no name)'}
        </h1>

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          <InfoRow label="Email" value={user.email} icon={<Mail className="w-3.5 h-3.5" />} />
          <InfoRow label="Student ID" value={user.studentId ?? '—'} />
          <InfoRow label="Role" value={user.role} />
          <InfoRow
            label="Enrolled"
            value={new Date(access.assignedAt).toLocaleDateString()}
          />
          <InfoRow
            label="Account created"
            value={new Date(user.createdAt).toLocaleDateString()}
          />
        </dl>
      </section>

      {/* Quiz results */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-emerald-400" />
            Quiz Results
          </h2>
          {quizResults.length > 0 && (
            <Link
              href={`/instructor/classrooms/${classroomId}/grades/${studentId}`}
              className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Full gradebook →
            </Link>
          )}
        </div>

        {quizResults.length === 0 ? (
          <EmptyState
            title="No quiz data yet"
            description="Quiz results will appear here once the student completes quizzes."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Scene / Quiz</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Graded by</th>
                  <th className="px-3 py-2">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {quizResults.map((r) => (
                  <tr key={r.id} className="hover:bg-white/4">
                    <td className="px-3 py-2 text-white">{r.sceneTitle}</td>
                    <td className="px-3 py-2 text-slate-200">
                      {r.score}/{r.maxScore}
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">
                      {r.gradedBy === 'ai' ? 'AI' : 'Instructor'}
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">
                      {new Date(r.gradedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function InfoRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-200 flex items-center gap-1.5">
        {icon}
        {value}
      </dd>
    </div>
  );
}
