import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Users, BookOpen, Calendar, Clock } from 'lucide-react';
import { readClassroom } from '@/lib/server/classroom-storage';
import { prisma } from '@/lib/auth/prisma';
import { auth } from '@/lib/auth/auth';
import { I18nText } from '@/components/i18n-text';
import type { ReactNode } from 'react';

export default async function InstructorClassroomOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const classroom = await readClassroom(id);
  if (!classroom) notFound();

  const session = await auth();

  const studentCount = await prisma.classroomAccess.count({
    where: {
      classroomId: id,
      NOT: { userId: session?.user?.id ?? '' },
    },
  });

  const title = classroom.stage.name || id;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-white">{title}</h1>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard icon={<Users className="w-4 h-4 text-indigo-400" />} label={<I18nText k="instructorClassroomOverview.students" fallback="Students" />} value={String(studentCount)} />
        <StatCard icon={<BookOpen className="w-4 h-4 text-emerald-400" />} label={<I18nText k="instructorClassroomOverview.scenes" fallback="Scenes" />} value={String(classroom.scenes.length)} />
        <StatCard
          icon={<Calendar className="w-4 h-4 text-amber-400" />}
          label={<I18nText k="instructorClassroomOverview.created" fallback="Created" />}
          value={new Date(classroom.createdAt).toLocaleDateString()}
        />
        <StatCard
          icon={<Clock className="w-4 h-4 text-slate-400" />}
          label={<I18nText k="instructorClassroomOverview.lastUpdated" fallback="Last updated" />}
          value={new Date(classroom.stage.updatedAt).toLocaleDateString()}
        />
      </div>

      {/* Quick actions */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <I18nText k="instructorClassroomOverview.quickActions" fallback="Quick actions" />
        </h2>
        <div className="flex flex-wrap gap-3">
          <ActionLink href={`/instructor/classrooms/${id}/students`} label={<I18nText k="instructorClassroomOverview.manageStudents" fallback="Manage Students" />} />
          <ActionLink href={`/instructor/classrooms/${id}/grades`} label={<I18nText k="instructorClassroomOverview.viewGrades" fallback="View Grades" />} />
          <ActionLink href={`/instructor/classrooms/${id}/content`} label={<I18nText k="instructorClassroomOverview.editContent" fallback="Edit Content" />} />
          <ActionLink href={`/classroom/${id}`} label={<I18nText k="instructorClassroomOverview.openCanvas" fallback="Open Canvas" />} external />
        </div>
      </section>

      {/* Scene preview */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <I18nText k="instructorClassroomOverview.scenePreview" fallback="Scene preview (first 5)" />
        </h2>
        {classroom.scenes.length === 0 ? (
          <p className="text-sm text-slate-500"><I18nText k="instructorClassroomOverview.noScenes" fallback="No scenes yet. Open the canvas to add content." /></p>
        ) : (
          <ul className="space-y-2">
            {classroom.scenes.slice(0, 5).map((scene) => (
              <li
                key={scene.id}
                className="flex items-center gap-3 rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-sm"
              >
                <span className="w-6 text-xs text-center text-slate-500">{scene.order}</span>
                <span className="flex-1 text-white">{scene.title || <I18nText k="instructorClassroomOverview.untitled" fallback="(untitled)" />}</span>
                <span className="rounded bg-white/8 px-2 py-0.5 text-xs text-slate-400">
                  {scene.type}
                </span>
              </li>
            ))}
            {classroom.scenes.length > 5 && (
              <li className="text-xs text-slate-500 px-3">
                +{classroom.scenes.length - 5}{' '}<I18nText k="instructorClassroomOverview.moreScenes" fallback="more scenes" />{' — '}
                <Link href={`/instructor/classrooms/${id}/content`} className="text-indigo-400 hover:underline">
                  <I18nText k="instructorClassroomOverview.viewAll" fallback="View all" />
                </Link>
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: ReactNode; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/8">
        {icon}
      </div>
      <div>
        <p className="text-sm font-semibold text-white">{value}</p>
        <p className="text-xs text-slate-400">{label}</p>
      </div>
    </div>
  );
}

function ActionLink({ href, label, external }: { href: string; label: ReactNode; external?: boolean }) {
  return (
    <Link
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 hover:bg-white/10 hover:text-white transition-colors"
    >
      {label}
      {external && <span className="ml-1 text-slate-500">↗</span>}
    </Link>
  );
}
