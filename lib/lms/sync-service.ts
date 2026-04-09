/**
 * Grade sync service: pushes pending OpenMAIC grades to configured LMS platforms.
 *
 * Run on-demand from /api/lms/sync or schedule via cron.
 */
import { prisma } from '@/lib/db/prisma';
import { getLMSProvider } from '@/lib/lms/registry';
import type { LMSConnection, SyncResult, ExternalGrade } from '@/lib/lms/types';

export class GradeSyncService {
  /** Sync all unsynced grades for all enabled integrations */
  async syncPendingGrades(): Promise<SyncResult> {
    const integrations = await prisma.lMSIntegration.findMany({
      where: { enabled: true },
      include: { syncRules: true },
    });

    const result: SyncResult = { total: 0, succeeded: 0, failed: 0, errors: [] };

    for (const integration of integrations) {
      const provider = getLMSProvider(integration.providerId);
      const config = integration.config as Record<string, unknown>;

      // Authenticate (real implementations should cache the connection)
      let connection: LMSConnection;
      try {
        connection = await provider.authenticate({
          baseUrl: String(config.baseUrl || ''),
          apiKey: config.apiKey as string | undefined,
          username: config.username as string | undefined,
          password: config.password as string | undefined,
          ...config,
        });
      } catch (e) {
        result.errors.push({ gradeId: 'auth', error: String(e) });
        continue;
      }

      for (const rule of integration.syncRules) {
        if (!rule.syncGrades) continue;

        const grades = await prisma.grade.findMany({
          where: {
            synced: false,
            lesson: { module: { courseId: rule.courseId } },
          },
          include: { user: true, lesson: true },
        });

        for (const g of grades) {
          result.total++;
          try {
            const external: ExternalGrade = {
              externalUserId: g.user.email || g.user.id,
              externalCourseId: rule.externalCourseId,
              externalItemId: g.lesson.stageId,
              score: g.score,
              maxScore: g.maxScore,
              feedback: g.feedback || undefined,
              timestamp: g.gradedAt,
            };
            await provider.pushGrade(connection, external);
            await prisma.grade.update({
              where: { id: g.id },
              data: { synced: true },
            });
            result.succeeded++;
          } catch (e) {
            result.failed++;
            result.errors.push({ gradeId: g.id, error: String(e) });
          }
        }
      }
    }

    return result;
  }
}

export const gradeSyncService = new GradeSyncService();
