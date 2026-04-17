/**
 * GET   /api/instructor/classrooms/[id]/grades/[studentId]
 *   Returns all QuizResult rows for one student (by DB user ID).
 *
 * PATCH /api/instructor/classrooms/[id]/grades/[studentId]
 *   Instructor override: update a single answer's score+comment.
 *   Body: { quizResultId, questionId, newScore, newComment }
 */

import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';

const overrideSchema = z.object({
  quizResultId: z.string().min(1),
  questionId: z.string().min(1),
  newScore: z.number().int().min(0),
  newComment: z.string().max(2000).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; studentId: string }> },
) {
  const session = await auth();
  if (!session?.user) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');

  const { id: classroomId, studentId } = await params;
  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
  }

  const results = await prisma.quizResult.findMany({
    where: { classroomId, studentDbUserId: studentId },
    orderBy: { gradedAt: 'desc' },
  });

  return apiSuccess({ results });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; studentId: string }> },
) {
  const session = await auth();
  if (!session?.user) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');

  const { id: classroomId } = await params;
  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  // Only instructor/admin may override grades
  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    if (session.user.role !== 'INSTRUCTOR') {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
    }
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
  }

  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      parsed.error.issues[0]?.message ?? 'Invalid request body',
    );
  }

  const { quizResultId, questionId, newScore, newComment } = parsed.data;

  // Verify the quiz result belongs to this classroom (prevents cross-classroom tampering)
  const existing = await prisma.quizResult.findFirst({
    where: { id: quizResultId, classroomId },
  });
  if (!existing) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Quiz result not found');
  }

  // Patch the specific answer within the JSON answers array
  const answers = existing.answers as Array<{
    questionId: string;
    answer: string;
    score: number;
    comment?: string;
    overrideScore?: number;
    overrideComment?: string;
  }>;

  const updatedAnswers = answers.map((a) => {
    if (a.questionId === questionId) {
      return {
        ...a,
        overrideScore: newScore,
        overrideComment: newComment ?? a.overrideComment,
      };
    }
    return a;
  });

  // Recompute total score using overrideScore where present
  const newTotal = updatedAnswers.reduce((sum, a) => {
    const s = a.overrideScore !== undefined ? a.overrideScore : a.score;
    return sum + s;
  }, 0);

  const updated = await prisma.quizResult.update({
    where: { id: quizResultId },
    data: {
      answers: updatedAnswers,
      score: Math.min(newTotal, existing.maxScore),
      gradedBy: session.user.id,
    },
  });

  return apiSuccess({ result: updated });
}
