import { readClassroom } from '@/lib/server/classroom-storage';
import { notFound } from 'next/navigation';
import { I18nText } from '@/components/i18n-text';

export default async function AdminClassroomContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const classroom = await readClassroom(id);
  if (!classroom) notFound();

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white"><I18nText k="adminClassroomContent.title" fallback="Content" /></h1>
      <div className="space-y-2 text-sm text-slate-300">
        <p><I18nText k="adminClassroomContent.sceneCount" fallback="Scene count" />: <span className="font-medium text-white">{classroom.scenes.length}</span></p>
        <p><I18nText k="adminClassroomContent.stageName" fallback="Stage name" />: <span className="font-medium text-white">{classroom.stage.name || classroom.id}</span></p>
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-400">
              <th className="px-3 py-2"><I18nText k="adminClassroomContent.columns.order" fallback="Order" /></th>
              <th className="px-3 py-2"><I18nText k="adminClassroomContent.columns.title" fallback="Title" /></th>
              <th className="px-3 py-2"><I18nText k="adminClassroomContent.columns.type" fallback="Type" /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {classroom.scenes.map((scene) => (
              <tr key={scene.id} className="hover:bg-white/5">
                <td className="px-3 py-2 text-slate-400">{scene.order}</td>
                <td className="px-3 py-2 text-white">{scene.title}</td>
                <td className="px-3 py-2 text-slate-300">{scene.type}</td>
              </tr>
            ))}
            {classroom.scenes.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-slate-500"><I18nText k="adminClassroomContent.noScenes" fallback="No scenes yet." /></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
