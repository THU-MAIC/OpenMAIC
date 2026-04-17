import { ClassroomAssignPanel } from '@/components/admin/classroom-assign-panel';
import { I18nText } from '@/components/i18n-text';

export default async function AdminClassroomStudentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white"><I18nText k="adminClassroomStudents.title" fallback="Students" /></h1>
      <ClassroomAssignPanel classroomId={id} />
    </section>
  );
}
