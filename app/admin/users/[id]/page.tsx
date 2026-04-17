import { prisma } from '@/lib/auth/prisma';
import { notFound } from 'next/navigation';
import { I18nText } from '@/components/i18n-text';

export default async function AdminUserOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      studentId: true,
      role: true,
      isActive: true,
      consentGiven: true,
      createdAt: true,
      lastLoginAt: true,
      _count: { select: { classroomAccess: true } },
    },
  });

  if (!user) notFound();

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white"><I18nText k="adminUserOverview.title" fallback="User Overview" /></h1>
      <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <Row label={<I18nText k="adminUserOverview.name" fallback="Name" />} value={user.name ?? '—'} />
        <Row label={<I18nText k="adminUserOverview.email" fallback="Email" />} value={user.email} />
        <Row label={<I18nText k="adminUserOverview.studentId" fallback="Student ID" />} value={user.studentId ?? '—'} />
        <Row label={<I18nText k="adminUserOverview.role" fallback="Role" />} value={user.role} />
        <Row
          label={<I18nText k="adminUserOverview.status" fallback="Status" />}
          value={user.isActive ? 'Active' : 'Disabled'}
          valueNode={user.isActive ? <I18nText k="adminUserOverview.active" fallback="Active" /> : <I18nText k="adminUserOverview.disabled" fallback="Disabled" />}
        />
        <Row
          label={<I18nText k="adminUserOverview.consent" fallback="Consent" />}
          value={user.consentGiven ? 'Given' : 'Not given'}
          valueNode={user.consentGiven ? <I18nText k="adminUserOverview.given" fallback="Given" /> : <I18nText k="adminUserOverview.notGiven" fallback="Not given" />}
        />
        <Row label={<I18nText k="adminUserOverview.classrooms" fallback="Classrooms" />} value={String(user._count.classroomAccess)} />
        <Row
          label={<I18nText k="adminUserOverview.lastLogin" fallback="Last login" />}
          value={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
          valueNode={!user.lastLoginAt ? <I18nText k="adminUserOverview.never" fallback="Never" /> : undefined}
        />
        <Row label={<I18nText k="adminUserOverview.created" fallback="Created" />} value={new Date(user.createdAt).toLocaleString()} />
      </dl>
    </section>
  );
}

function Row({
  label,
  value,
  valueNode,
}: {
  label: React.ReactNode;
  value: string;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-200">{valueNode ?? value}</dd>
    </div>
  );
}
