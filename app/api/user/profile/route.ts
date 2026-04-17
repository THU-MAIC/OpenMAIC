import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';

const profileSchema = z.object({
  bio: z.string().max(500).optional(),
  image: z.string().url().optional().or(z.literal('')),
});

const passwordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z
    .string()
    .min(10)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])/),
});

/** GET /api/user/profile */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, studentId: true, image: true, bio: true, role: true, consentGiven: true, consentAt: true, lastLoginAt: true, createdAt: true },
  });
  return NextResponse.json({ user });
}

/** PATCH /api/user/profile */
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();

  // Password change
  if ('currentPassword' in body) {
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user?.hashedPassword) {
      return NextResponse.json({ error: 'Password change not available for OAuth accounts' }, { status: 400 });
    }
    const valid = await bcrypt.compare(parsed.data.currentPassword, user.hashedPassword);
    if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });

    const newHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await prisma.user.update({ where: { id: session.user.id }, data: { hashedPassword: newHash } });

    void writeAuditLog({ actorId: session.user.id, action: 'user.password_change', resource: 'User', resourceId: session.user.id, req });
    return NextResponse.json({ success: true });
  }

  // Profile update
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const attemptedImmutableFields = 'name' in body || 'role' in body || 'studentId' in body;

  if (attemptedImmutableFields) {
    if (session.user.role === 'STUDENT' || session.user.role === 'INSTRUCTOR') {
      return NextResponse.json(
        { error: 'Students and instructors are not allowed to change full name, role, or student ID' },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { error: 'Full name, role, and student ID can only be changed by an admin' },
      { status: 403 },
    );
  }

  const user = await prisma.user.update({
    where: { id: session.user.id },
    data: parsed.data,
    select: { id: true, name: true, email: true, studentId: true, image: true, bio: true },
  });

  void writeAuditLog({ actorId: session.user.id, action: 'user.profile_update', resource: 'User', resourceId: session.user.id, req });
  return NextResponse.json({ user });
}
