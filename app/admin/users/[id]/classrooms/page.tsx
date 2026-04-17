import Link from 'next/link';
import { prisma } from '@/lib/auth/prisma';
import { readClassroom } from '@/lib/server/classroom-storage';

export default async function AdminUserClassroomsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const rows = await prisma.classroomAccess.findMany({
    where: { userId: id },
    orderBy: { assignedAt: 'desc' },
  });

  const classrooms = await Promise.all(
    rows.map(async (row) => {
      const persisted = await readClassroom(row.classroomId);
      return {
        classroomId: row.classroomId,
        title: persisted?.stage?.name ?? row.classroomId,
        assignedAt: row.assignedAt,
        assignedBy: row.assignedBy,
      };
    }),
  );

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h1 className="mb-4 text-xl font-semibold text-white">User Classrooms</h1>
      {classrooms.length === 0 ? (
        <p className="text-sm text-slate-500">No classroom assignments found.</p>
      ) : (
        <ul className="space-y-2">
          {classrooms.map((item) => (
            <li key={`${item.classroomId}-${item.assignedAt.toISOString()}`} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-white">{item.title}</p>
                  <p className="font-mono text-xs text-slate-500">{item.classroomId}</p>
                </div>
                <Link href={`/admin/classrooms/${item.classroomId}`} className="text-sm text-primary hover:text-primary/80">Open</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
