import { prisma } from '@/lib/auth/prisma';
import { requireRole, userOwnsClassroom, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';

const assignSchema = z.object({
  userIds: z.array(z.string()).min(1),
});

/** GET /api/admin/classrooms/[id]/assign — list assigned students */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireRole('INSTRUCTOR');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id: classroomId } = await params;
  const owns = await userOwnsClassroom(session.user.id, classroomId);
  if (!owns) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const assignments = await prisma.classroomAccess.findMany({
    where: { classroomId },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  });
  return NextResponse.json({ assignments });
}

/** POST /api/admin/classrooms/[id]/assign — assign students */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireRole('INSTRUCTOR');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id: classroomId } = await params;
  const owns = await userOwnsClassroom(session.user.id, classroomId);
  if (!owns) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { userIds } = parsed.data;
  await prisma.classroomAccess.createMany({
    data: userIds.map((userId) => ({
      userId,
      classroomId,
      assignedBy: session.user.id,
    })),
    skipDuplicates: true,
  });

  void writeAuditLog({
    actorId: session.user.id,
    action: 'classroom.assign_students',
    resource: 'Classroom',
    resourceId: classroomId,
    details: { userIds },
    req,
  });

  return NextResponse.json({ success: true });
}

/** DELETE /api/admin/classrooms/[id]/assign — remove student */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireRole('INSTRUCTOR');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id: classroomId } = await params;
  const owns = await userOwnsClassroom(session.user.id, classroomId);
  if (!owns) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const userId = searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  await prisma.classroomAccess.deleteMany({ where: { classroomId, userId } });

  void writeAuditLog({
    actorId: session.user.id,
    action: 'classroom.remove_student',
    resource: 'Classroom',
    resourceId: classroomId,
    details: { userId },
    req,
  });

  return NextResponse.json({ success: true });
}
