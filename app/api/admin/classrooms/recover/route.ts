import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireRole, ensureClassroomOwnership } from '@/lib/auth/helpers';
import { prisma } from '@/lib/auth/prisma';
import { listDeletedClassrooms, restoreDeletedClassroom } from '@/lib/server/classroom-storage';

/** GET /api/admin/classrooms/recover - list soft-deleted classrooms */
export async function GET() {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const classrooms = await listDeletedClassrooms();
  return NextResponse.json({ classrooms });
}

/** POST /api/admin/classrooms/recover - restore one classroom to its owner */
export async function POST(req: NextRequest) {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { id?: string };
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const classroomId = body.id?.trim();
  if (!classroomId) {
    return NextResponse.json({ error: 'Missing classroom id' }, { status: 400 });
  }

  const restored = await restoreDeletedClassroom(classroomId);
  if (!restored) {
    return NextResponse.json({ error: 'Classroom not found in deleted records' }, { status: 404 });
  }

  await prisma.classroomAccess.deleteMany({ where: { classroomId } });
  await ensureClassroomOwnership(restored.ownerUserId, classroomId);

  return NextResponse.json({
    success: true,
    id: classroomId,
    ownerUserId: restored.ownerUserId,
    restoredAt: new Date().toISOString(),
  });
}
