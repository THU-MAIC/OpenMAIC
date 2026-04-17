import { prisma } from '@/lib/auth/prisma';
import { requireRole, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])/;

const patchUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  studentId: z.string().trim().min(1).max(50).optional().or(z.literal('')),
  password: z.string().min(10).regex(PASSWORD_REGEX).optional().or(z.literal('')),
  role: z.enum(['ADMIN', 'INSTRUCTOR', 'STUDENT']).optional(),
  isActive: z.boolean().optional(),
});

/** GET /api/admin/users/[id] */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    include: { classroomAccess: true },
  });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ user });
}

/** PATCH /api/admin/users/[id] */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const parsed = patchUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { password, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (rest.email) updateData.email = rest.email.toLowerCase();
  if ('studentId' in rest) updateData.studentId = rest.studentId?.trim() || null;
  if (rest.role && rest.role !== 'STUDENT' && !('studentId' in rest)) {
    updateData.studentId = null;
  }
  if (password) updateData.hashedPassword = await bcrypt.hash(password, 12);

  try {
    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, email: true, studentId: true, role: true, isActive: true },
    });

    void writeAuditLog({
      actorId: session.user.id,
      targetId: id,
      action: 'user.update',
      resource: 'User',
      resourceId: id,
      details: { changes: Object.keys(updateData) },
      req,
    });

    return NextResponse.json({ user });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

/** DELETE /api/admin/users/[id] */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;

  // Prevent self-deletion
  if (session.user.id === id) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 });
  }

  await prisma.user.delete({ where: { id } });

  void writeAuditLog({
    actorId: session.user.id,
    action: 'user.delete',
    resource: 'User',
    resourceId: id,
    req,
  });

  return NextResponse.json({ success: true });
}
