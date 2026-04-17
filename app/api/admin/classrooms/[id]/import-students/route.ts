import { prisma } from '@/lib/auth/prisma';
import { requirePermissions, userOwnsClassroom, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { generateTemporaryPassword } from '@/lib/utils/generate-password';
import { sendClassroomInvitationEmail, sendStudentWelcomeEmail } from '@/lib/email/mailer';

const studentRowSchema = z.object({
  name: z.string().trim().min(1),
  studentId: z.string().trim().min(1).max(50).optional().or(z.literal('')),
  email: z.string().trim().email().optional().or(z.literal('')),
});

const importSchema = z.object({
  students: z.array(studentRowSchema).min(1).max(2000),
});

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
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const passwordsToShare: Array<{ name: string; email: string; password: string }> = [];
  const assignedStudents: Array<{ name: string; studentId?: string; email?: string }> = [];
  const failures: Array<{ row: number; name: string; reason: string }> = [];

  let createdCount = 0;
  let existingCount = 0;
  let assignedCount = 0;
  let emailSentCount = 0;

  for (let i = 0; i < parsed.data.students.length; i++) {
    const row = parsed.data.students[i];
    const name = row.name.trim();
    const studentId = row.studentId?.trim() || undefined;
    const email = row.email?.trim().toLowerCase() || undefined;

    if (!name) {
      failures.push({ row: i + 1, name: '', reason: 'Missing full name' });
      continue;
    }

    let user = null as Awaited<ReturnType<typeof prisma.user.findUnique>>;
    if (email) {
      user = await prisma.user.findUnique({ where: { email } });
    }
    if (!user && studentId) {
      user = await prisma.user.findUnique({ where: { studentId } });
    }

    if (!user) {
      if (!email) {
        failures.push({
          row: i + 1,
          name,
          reason: 'Email is required for new students (no existing account found by student ID).',
        });
        continue;
      }

      const temporaryPassword = generateTemporaryPassword();
      const hashedPassword = await bcrypt.hash(temporaryPassword, 12);

      try {
        user = await prisma.user.create({
          data: {
            name,
            email,
            studentId: studentId ?? null,
            hashedPassword,
            role: 'STUDENT',
            isActive: true,
          },
        });
        createdCount += 1;

        let emailSent = false;
        try {
          await sendStudentWelcomeEmail({
            to: email,
            name,
            temporaryPassword,
            classroomId,
          });
          emailSent = true;
          emailSentCount += 1;
        } catch {
          emailSent = false;
        }

        if (!emailSent) {
          passwordsToShare.push({ name, email, password: temporaryPassword });
        }
      } catch {
        failures.push({
          row: i + 1,
          name,
          reason: 'Failed to create student account (email or student ID may already exist).',
        });
        continue;
      }
    } else {
      existingCount += 1;

      if (user.email) {
        try {
          await sendClassroomInvitationEmail({
            to: user.email,
            name: user.name ?? name,
            classroomId,
          });
          emailSentCount += 1;
        } catch {
          // SMTP not configured or delivery failed.
        }
      }
    }

    if (!user) {
      failures.push({ row: i + 1, name, reason: 'Unable to resolve user account.' });
      continue;
    }

    await prisma.classroomAccess.upsert({
      where: { userId_classroomId: { userId: user.id, classroomId } },
      update: {},
      create: {
        userId: user.id,
        classroomId,
        assignedBy: session.user.id,
      },
    });

    assignedCount += 1;
    assignedStudents.push({
      name: user.name ?? name,
      studentId: user.studentId ?? studentId,
      email: user.email ?? email,
    });
  }

  void writeAuditLog({
    actorId: session.user.id,
    action: 'student.import',
    resource: 'Classroom',
    resourceId: classroomId,
    details: {
      totalRows: parsed.data.students.length,
      createdCount,
      existingCount,
      assignedCount,
      emailSentCount,
      failedCount: failures.length,
    },
    req,
  });

  return NextResponse.json({
    totalRows: parsed.data.students.length,
    createdCount,
    existingCount,
    assignedCount,
    emailSentCount,
    failedCount: failures.length,
    failures,
    passwordsToShare,
    assignedStudents,
  });
}
