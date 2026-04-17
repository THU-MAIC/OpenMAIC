import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { readClassroom } from '@/lib/server/classroom-storage';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.role !== 'STUDENT') {
    return NextResponse.json({ classrooms: [] });
  }

  const assignments = await prisma.classroomAccess.findMany({
    where: { userId: session.user.id },
    orderBy: { assignedAt: 'desc' },
  });

  const classrooms = await Promise.all(
    assignments.map(async (assignment) => {
      const persisted = await readClassroom(assignment.classroomId);
      const isOwnedByUser =
        assignment.assignedBy === session.user.id ||
        persisted?.stage?.ownerUserId === session.user.id;
      if (isOwnedByUser) {
        return null;
      }

      return {
        id: assignment.classroomId,
        name: persisted?.stage?.name || assignment.classroomId,
        description: persisted?.stage?.description || '',
        createdAt: persisted?.stage?.createdAt || new Date(assignment.assignedAt).getTime(),
        updatedAt: persisted?.stage?.updatedAt || new Date(assignment.assignedAt).getTime(),
        assignedAt: assignment.assignedAt.getTime(),
      };
    }),
  );

  return NextResponse.json({ classrooms: classrooms.filter(Boolean) });
}
