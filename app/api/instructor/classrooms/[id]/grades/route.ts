/**
 * GET  /api/instructor/classrooms/[id]/grades
 *   Returns all QuizResult rows for the classroom, grouped by studentDbUserId.
 *
 * POST /api/instructor/classrooms/[id]/grades
 *   Creates a new QuizResult. Called from the quiz player upon completion.
 *   Body: { studentDbUserId?, studentLabel, sceneId, sceneTitle, score, maxScore, answers[], gradedBy }
 */

import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { userHasClassroomAccess, userOwnsClassroom } from '@/lib/auth/helpers';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';

const answerItemSchema = z.object({
  questionId: z.string(),
  answer: z.string(),
  score: z.number().int().min(0),
  comment: z.string().optional(),
});

const createResultSchema = z.object({
  studentDbUserId: z.string().optional(),
  studentLabel: z.string().min(1).max(300),
  sceneId: z.string().min(1),
  sceneTitle: z.string().min(1).max(500),
  score: z.number().int().min(0),
  maxScore: z.number().int().min(1),
  answers: z.array(answerItemSchema).default([]),
  gradedBy: z.string().min(1).max(200).default('ai'),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');

  const { id: classroomId } = await params;
  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  // Only owner or ADMIN may view grades
  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
  }

  const results = await prisma.quizResult.findMany({
    where: { classroomId },
    orderBy: { gradedAt: 'desc' },
  });

  return apiSuccess({ results });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');

  const { id: classroomId } = await params;
  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  // Students may submit their own results only if they can access this classroom.
  // Instructors must own the classroom; admins are allowed.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
  }

  const parsed = createResultSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      parsed.error.issues[0]?.message ?? 'Invalid request body',
    );
  }

  const { studentDbUserId, studentLabel, sceneId, sceneTitle, score, maxScore, answers, gradedBy } =
    parsed.data;

  const isAdmin = session.user.role === 'ADMIN';
  const isStudent = session.user.role === 'STUDENT';

  let resolvedStudentDbUserId: string | null = studentDbUserId ?? null;

  if (isStudent) {
    if (studentDbUserId && studentDbUserId !== session.user.id) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Students can only submit their own results');
    }
    const hasAccess = await userHasClassroomAccess(session.user.id, session.user.role, classroomId);
    if (!hasAccess) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'No classroom access');
    }
    resolvedStudentDbUserId = session.user.id;
  } else if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
    }
  }

  const result = await prisma.quizResult.create({
    data: {
      classroomId,
      studentDbUserId: resolvedStudentDbUserId,
      studentLabel,
      sceneId,
      sceneTitle,
      score,
      maxScore,
      answers,
      gradedBy,
    },
  });

  return apiSuccess({ result }, 201);
}
