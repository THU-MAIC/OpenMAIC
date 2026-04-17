import { prisma } from '@/lib/auth/prisma';
import { requireRole } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import { readClassroom } from '@/lib/server/classroom-storage';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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
        assignedAt: row.assignedAt,
        assignedBy: row.assignedBy,
        title: persisted?.stage?.name ?? row.classroomId,
      };
    }),
  );

  return NextResponse.json({ classrooms });
}
