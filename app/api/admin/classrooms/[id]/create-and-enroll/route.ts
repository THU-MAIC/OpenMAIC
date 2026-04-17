import { prisma } from '@/lib/auth/prisma';
import { requirePermissions, userOwnsClassroom, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { generateTemporaryPassword } from '@/lib/utils/generate-password';
import { sendClassroomInvitationEmail, sendStudentWelcomeEmail } from '@/lib/email/mailer';

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  studentId: z.string().trim().min(1).max(50).optional().or(z.literal('')),
  notes: z.string().max(500).optional().or(z.literal('')),
});

/**
 * POST /api/admin/classrooms/[id]/create-and-enroll
 *
 * Creates a new STUDENT account with a generated temporary password, grants
 * them access to the given classroom, and sends a welcome email if SMTP is
 * configured.  If a user with the provided email already exists the endpoint
 * just grants classroom access (idempotent) without returning a password.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requirePermissions('create_students_own_classrooms');
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

  const { name, email, studentId, notes } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  // If the user already exists, just grant access — no new account/password needed
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    await prisma.classroomAccess.upsert({
      where: { userId_classroomId: { userId: existing.id, classroomId } },
      update: {},
      create: { userId: existing.id, classroomId, assignedBy: session.user.id },
    });

    let invitationSent = false;
    try {
      await sendClassroomInvitationEmail({
        to: existing.email,
        name: existing.name ?? name,
        classroomId,
      });
      invitationSent = true;
    } catch {
      // SMTP not configured or delivery failed.
    }

    return NextResponse.json({
      userId: existing.id,
      alreadyExisted: true,
      emailSent: invitationSent,
    });
  }

  // Generate credentials
  const temporaryPassword = generateTemporaryPassword();
  const hashedPassword = await bcrypt.hash(temporaryPassword, 12);

  const user = await prisma.user.create({
    data: {
      name,
      email: normalizedEmail,
      studentId: studentId?.trim() || null,
      hashedPassword,
      role: 'STUDENT',
      isActive: true,
    },
    select: { id: true },
  });

  // Grant classroom access
  await prisma.classroomAccess.create({
    data: { userId: user.id, classroomId, assignedBy: session.user.id },
  });

  // Send welcome email (best-effort — failure does not roll back the account)
  let emailSent = false;
  try {
    await sendStudentWelcomeEmail({ to: normalizedEmail, name, temporaryPassword, classroomId });
    emailSent = true;
  } catch {
    // SMTP not configured or delivery failed — caller receives the password to share manually
  }

  void writeAuditLog({
    actorId: session.user.id,
    action: 'student.create_and_enroll',
    resource: 'Classroom',
    resourceId: classroomId,
    details: { name, email: normalizedEmail, studentId: studentId || null, notes: notes || null, emailSent },
    req,
  });

  return NextResponse.json({ userId: user.id, temporaryPassword, emailSent });
}
