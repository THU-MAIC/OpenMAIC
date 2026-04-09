import { prisma } from '@/lib/db/prisma';
import type { Grade } from '@prisma/client';

export interface QuizAnswer {
  questionId: string;
  selected: string[]; // For text answers, [text]
  correct: boolean;
  points: number;
  maxPoints: number;
}

export interface GradeRecord {
  userId: string;
  lessonId: string;
  sceneId?: string;
  score: number;
  maxScore: number;
  feedback?: string;
}

export class GradeService {
  /** Record an auto-graded quiz result */
  async recordQuizGrade(
    userId: string,
    lessonId: string,
    sceneId: string,
    answers: QuizAnswer[],
  ): Promise<Grade> {
    const totalPoints = answers.reduce((s, a) => s + a.points, 0);
    const totalMax = answers.reduce((s, a) => s + a.maxPoints, 0);
    const score = totalMax > 0 ? (totalPoints / totalMax) * 100 : 0;

    return prisma.grade.create({
      data: {
        userId,
        lessonId,
        sceneId,
        score,
        maxScore: 100,
        gradedBy: 'system',
      },
    });
  }

  /** Record a manual grade from a teacher */
  async recordManualGrade(
    teacherId: string,
    record: GradeRecord,
  ): Promise<Grade> {
    return prisma.grade.create({
      data: {
        userId: record.userId,
        lessonId: record.lessonId,
        sceneId: record.sceneId,
        score: record.score,
        maxScore: record.maxScore,
        feedback: record.feedback,
        gradedBy: teacherId,
      },
    });
  }

  /** Get all grades for a student in a course */
  async getStudentGrades(userId: string, courseId: string): Promise<Grade[]> {
    return prisma.grade.findMany({
      where: {
        userId,
        lesson: { module: { courseId } },
      },
      orderBy: { gradedAt: 'desc' },
    });
  }

  /** Get all grades for a lesson (teacher gradebook view) */
  async getLessonGrades(lessonId: string): Promise<Grade[]> {
    return prisma.grade.findMany({
      where: { lessonId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { gradedAt: 'desc' },
    });
  }

  /** Mark grades as synced to an external LMS */
  async markSynced(gradeIds: string[], externalIds: Record<string, string>): Promise<void> {
    await Promise.all(
      gradeIds.map((id) =>
        prisma.grade.update({
          where: { id },
          data: { synced: true, externalId: externalIds[id] },
        }),
      ),
    );
  }
}

export const gradeService = new GradeService();
