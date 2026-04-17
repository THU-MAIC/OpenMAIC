import { readClassroom } from '@/lib/server/classroom-storage';
import { prisma } from '@/lib/auth/prisma';
import { notFound } from 'next/navigation';
import { I18nText } from '@/components/i18n-text';
import type { ReactNode } from 'react';

export default async function AdminClassroomOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const classroom = await readClassroom(id);
  if (!classroom) notFound();

  const studentCount = await prisma.classroomAccess.count({
    where: {
      classroomId: id,
      ...(classroom.stage.ownerUserId ? { userId: { not: classroom.stage.ownerUserId } } : {}),
    },
  });

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white"><I18nText k="adminClassroomOverview.title" fallback="Classroom Overview" /></h1>
      <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <Row label={<I18nText k="adminClassroomOverview.classroomId" fallback="Classroom ID" />} value={classroom.id} mono />
        <Row label={<I18nText k="adminClassroomOverview.title_field" fallback="Title" />} value={classroom.stage.name || classroom.id} />
        <Row label={<I18nText k="adminClassroomOverview.description" fallback="Description" />} value={classroom.stage.description || '—'} />
        <Row label={<I18nText k="adminClassroomOverview.owner" fallback="Owner" />} value={classroom.stage.ownerUserId || 'Unknown'} mono />
        <Row label={<I18nText k="adminClassroomOverview.students" fallback="Students" />} value={String(studentCount)} />
        <Row label={<I18nText k="adminClassroomOverview.scenes" fallback="Scenes" />} value={String(classroom.scenes.length)} />
        <Row label={<I18nText k="adminClassroomOverview.created" fallback="Created" />} value={new Date(classroom.createdAt).toLocaleString()} />
      </dl>
    </section>
  );
}

function Row({ label, value, mono }: { label: ReactNode; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-1 text-slate-200 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
