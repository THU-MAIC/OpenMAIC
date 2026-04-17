import { prisma } from '@/lib/auth/prisma';
import { requireRole, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])/;

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  studentId: z.string().trim().min(1).max(50).optional().or(z.literal('')),
  password: z.string().min(10).regex(PASSWORD_REGEX),
  role: z.enum(['ADMIN', 'INSTRUCTOR', 'STUDENT']).default('STUDENT'),
  isActive: z.boolean().default(true),
});

/** GET /api/admin/users */
export async function GET(req: NextRequest) {
  let session;
  let callerIsInstructor = false;
  try {
    session = await requireRole('ADMIN', 'INSTRUCTOR');
    callerIsInstructor = session.user.role === 'INSTRUCTOR';
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') ?? '';
  const roleFilter = searchParams.get('role');

  // Instructors may only search for students
  const effectiveRoleFilter = callerIsInstructor ? 'STUDENT' : roleFilter;

  const users = await prisma.user.findMany({
    where: {
      ...(q && {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      }),
      ...(effectiveRoleFilter && { role: effectiveRoleFilter as 'ADMIN' | 'INSTRUCTOR' | 'STUDENT' }),
    },
    select: {
      id: true,
      name: true,
      email: true,
      studentId: true,
      role: true,
      isActive: true,
      consentGiven: true,
      lastLoginAt: true,
      createdAt: true,
      _count: { select: { classroomAccess: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ users });
}

/** POST /api/admin/users */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { name, email, studentId, password, role, isActive } = parsed.data;
  const hashedPassword = await bcrypt.hash(password, 12);

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        studentId: role === 'STUDENT' ? studentId?.trim() || null : null,
        hashedPassword,
        role,
        isActive,
      },
      select: { id: true, name: true, email: true, studentId: true, role: true },
    });

    void writeAuditLog({
      actorId: session.user.id,
      targetId: user.id,
      action: 'user.create',
      resource: 'User',
      resourceId: user.id,
      details: { name, email, role, studentId: role === 'STUDENT' ? studentId?.trim() || null : null },
      req,
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }
}
