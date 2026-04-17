import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/auth/prisma';
import { ensureClassroomOwnership, requireRole, writeAuditLog } from '@/lib/auth/helpers';
import { buildRequestOrigin, isValidClassroomId, persistClassroom, readClassroom } from '@/lib/server/classroom-storage';
import { listDeletedClassrooms } from '@/lib/server/classroom-storage';
import type { Stage } from '@/lib/types/stage';

const createClassroomSchema = z.object({
  classroomId: z.string().trim().min(3).max(64),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  sourceType: z.enum(['blank', 'template', 'import']).default('blank'),
  templateId: z.string().trim().max(120).optional().or(z.literal('')),
  studentIds: z.array(z.string()).optional().default([]),
  startAt: z.string().nullable().optional(),
  endAt: z.string().nullable().optional(),
  pacingMode: z.enum(['self_paced', 'scheduled']).default('self_paced'),
});

export async function GET() {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rows = await prisma.classroomAccess.findMany({
    select: { classroomId: true },
    distinct: ['classroomId'],
    orderBy: { assignedAt: 'desc' },
  });

  const deleted = await listDeletedClassrooms();
  const deletedById = new Map(deleted.map((d) => [d.id, d]));

  const classrooms = await Promise.all(
    rows.map(async (row) => {
      const classroom = await readClassroom(row.classroomId);
      if (!classroom) {
        const deletedRecord = deletedById.get(row.classroomId);
        return {
          classroomId: row.classroomId,
          title: '(missing classroom)',
          ownerUserId: deletedRecord?.ownerUserId ?? 'unknown',
          studentCount: 0,
          updatedAt: deletedRecord?.deletedAt ?? new Date().toISOString(),
          status: 'missing' as const,
          recoverable: Boolean(deletedRecord),
        };
      }

      const ownerUserId = classroom?.stage?.ownerUserId;
      const studentCount = await prisma.classroomAccess.count({
        where: {
          classroomId: row.classroomId,
          ...(ownerUserId ? { userId: { not: ownerUserId } } : {}),
        },
      });

      return {
        classroomId: row.classroomId,
        title: classroom?.stage?.name ?? row.classroomId,
        ownerUserId: ownerUserId ?? 'unknown',
        studentCount,
        updatedAt: new Date(classroom?.stage?.updatedAt ?? Date.now()).toISOString(),
        status: 'active' as const,
        recoverable: false,
      };
    }),
  );

  return NextResponse.json({ classrooms });
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createClassroomSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const {
    classroomId,
    title,
    description,
    sourceType,
    templateId,
    studentIds,
    startAt,
    endAt,
    pacingMode,
  } = parsed.data;

  if (!isValidClassroomId(classroomId)) {
    return NextResponse.json({ error: 'Invalid classroom id format' }, { status: 400 });
  }

  const parsedStartAt = startAt ? new Date(startAt) : null;
  const parsedEndAt = endAt ? new Date(endAt) : null;

  if (parsedStartAt && Number.isNaN(parsedStartAt.getTime())) {
    return NextResponse.json({ error: 'Invalid start date' }, { status: 400 });
  }

  if (parsedEndAt && Number.isNaN(parsedEndAt.getTime())) {
    return NextResponse.json({ error: 'Invalid end date' }, { status: 400 });
  }

  if (parsedStartAt && parsedEndAt && parsedEndAt.getTime() <= parsedStartAt.getTime()) {
    return NextResponse.json({ error: 'End date must be after start date' }, { status: 400 });
  }

  const existing = await readClassroom(classroomId);
  if (existing) {
    return NextResponse.json({ error: 'Classroom ID already exists' }, { status: 409 });
  }

  const now = Date.now();
  const stage: Stage = {
    id: classroomId,
    name: title,
    description: description || undefined,
    ownerUserId: session.user.id,
    createdAt: now,
    updatedAt: now,
    ownershipType: 'owned',
  };

  await persistClassroom(
    {
      id: classroomId,
      stage,
      scenes: [],
    },
    buildRequestOrigin(req),
  );

  await ensureClassroomOwnership(session.user.id, classroomId);

  if (studentIds.length) {
    await prisma.classroomAccess.createMany({
      data: studentIds.map((userId) => ({
        userId,
        classroomId,
        assignedBy: session.user.id,
      })),
      skipDuplicates: true,
    });
  }

  void writeAuditLog({
    actorId: session.user.id,
    action: 'classroom.create',
    resource: 'Classroom',
    resourceId: classroomId,
    details: {
      title,
      description: description || null,
      sourceType,
      templateId: templateId || null,
      startAt,
      endAt,
      pacingMode,
      studentCount: studentIds.length,
    },
    req,
  });

  return NextResponse.json(
    {
      classroom: {
        id: classroomId,
        title,
        ownerUserId: session.user.id,
        studentCount: studentIds.length,
        createdAt: new Date().toISOString(),
      },
    },
    { status: 201 },
  );
}
