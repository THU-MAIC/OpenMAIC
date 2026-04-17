import { prisma } from '@/lib/auth/prisma';
import { requireRole, userOwnsClassroom, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { generateTemporaryPassword } from '@/lib/utils/generate-password';
import { sendClassroomInvitationEmail, sendStudentWelcomeEmail } from '@/lib/email/mailer';

const schema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  studentId: z.string().trim().min(1).max(50).optional().or(z.literal('')),
});

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
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { name, email, studentId } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const trimmedStudentId = studentId?.trim() || undefined;

  let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user && trimmedStudentId) {
    user = await prisma.user.findUnique({ where: { studentId: trimmedStudentId } });
  }

  let emailSent = false;

  if (user) {
    await prisma.classroomAccess.upsert({
      where: { userId_classroomId: { userId: user.id, classroomId } },
      update: {},
      create: { userId: user.id, classroomId, assignedBy: session.user.id },
    });

    try {
      await sendClassroomInvitationEmail({
        to: user.email,
        name: user.name ?? name,
        classroomId,
      });
      emailSent = true;
    } catch {
      // SMTP not configured or delivery failed.
    }

    void writeAuditLog({
      actorId: session.user.id,
      targetId: user.id,
      action: 'student.resend_invitation',
      resource: 'Classroom',
      resourceId: classroomId,
      details: { existingUser: true, emailSent },
      req,
    });

    return NextResponse.json({
      userId: user.id,
      alreadyExisted: true,
      emailSent,
    });
  }

  const temporaryPassword = generateTemporaryPassword();
  const hashedPassword = await bcrypt.hash(temporaryPassword, 12);

  user = await prisma.user.create({
    data: {
      name,
      email: normalizedEmail,
      studentId: trimmedStudentId ?? null,
      hashedPassword,
      role: 'STUDENT',
      isActive: true,
    },
  });

  await prisma.classroomAccess.create({
    data: { userId: user.id, classroomId, assignedBy: session.user.id },
  });

  try {
    await sendStudentWelcomeEmail({
      to: normalizedEmail,
      name,
      temporaryPassword,
      classroomId,
    });
    emailSent = true;
  } catch {
    // SMTP not configured or delivery failed.
  }

  void writeAuditLog({
    actorId: session.user.id,
    targetId: user.id,
    action: 'student.resend_invitation',
    resource: 'Classroom',
    resourceId: classroomId,
    details: { existingUser: false, emailSent },
    req,
  });

  return NextResponse.json({
    userId: user.id,
    temporaryPassword,
    emailSent,
    alreadyExisted: false,
  });
}