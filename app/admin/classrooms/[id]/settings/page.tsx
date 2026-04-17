import { readClassroom } from '@/lib/server/classroom-storage';
import { notFound } from 'next/navigation';
import { I18nText } from '@/components/i18n-text';

export default async function AdminClassroomSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const classroom = await readClassroom(id);
  if (!classroom) notFound();

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white"><I18nText k="adminClassroomSettings.title" fallback="Settings" /></h1>
      <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <Card label={<I18nText k="adminClassroomSettings.ownerUserId" fallback="Owner user ID" />} value={classroom.stage.ownerUserId || 'Unknown'} mono />
        <Card label={<I18nText k="adminClassroomSettings.createdAt" fallback="Created at" />} value={new Date(classroom.createdAt).toLocaleString()} />
        <Card label={<I18nText k="adminClassroomSettings.stageUpdatedAt" fallback="Stage updated at" />} value={new Date(classroom.stage.updatedAt).toLocaleString()} />
        <Card label={<I18nText k="adminClassroomSettings.stageLanguage" fallback="Stage language" />} value={classroom.stage.language || 'Default'} />
      </div>
    </section>
  );
}

function Card({ label, value, mono }: { label: React.ReactNode; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-slate-200 ${mono ? 'font-mono text-xs' : ''}`}>{value}</p>
    </div>
  );
}
