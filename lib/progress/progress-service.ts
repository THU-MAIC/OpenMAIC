import { prisma } from '@/lib/db/prisma';
import type { StudentProgress } from '@prisma/client';

export class ProgressService {
  /** Update or create progress for a student in a lesson */
  async updateProgress(
    userId: string,
    lessonId: string,
    sceneIndex: number,
    timeSpentDelta: number = 0,
  ): Promise<StudentProgress> {
    return prisma.studentProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: {
        userId,
        lessonId,
        sceneIndex,
        timeSpent: timeSpentDelta,
      },
      update: {
        sceneIndex,
        timeSpent: { increment: timeSpentDelta },
      },
    });
  }

  /** Mark a lesson as completed */
  async markCompleted(userId: string, lessonId: string): Promise<StudentProgress> {
    return prisma.studentProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: {
        userId,
        lessonId,
        sceneIndex: 0,
        completed: true,
        completedAt: new Date(),
      },
      update: {
        completed: true,
        completedAt: new Date(),
      },
    });
  }

  /** Get a student's progress for a course */
  async getCourseProgress(userId: string, courseId: string): Promise<StudentProgress[]> {
    return prisma.studentProgress.findMany({
      where: {
        userId,
        lesson: { module: { courseId } },
      },
    });
  }

  /** Get progress for all students in a lesson */
  async getLessonProgress(lessonId: string): Promise<StudentProgress[]> {
    return prisma.studentProgress.findMany({
      where: { lessonId },
    });
  }
}

export const progressService = new ProgressService();
