import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * GET /api/user/data-export
 * PDPA: Right of access — export all personal data as JSON
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;

  const [user, auditLogs, classroomAccess] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, bio: true, role: true,
        consentGiven: true, consentAt: true, lastLoginAt: true, createdAt: true, updatedAt: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { actorId: userId },
      select: { action: true, resource: true, createdAt: true, ipAddress: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.classroomAccess.findMany({
      where: { userId },
      select: { classroomId: true, assignedAt: true },
    }),
  ]);

  const exportData = {
    exportedAt: new Date().toISOString(),
    notice: 'Exported under Thailand PDPA – right of access',
    profile: user,
    classroomAccess,
    activityLog: auditLogs,
  };

  void writeAuditLog({ actorId: userId, action: 'user.data_export', resource: 'User', resourceId: userId, req });

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="openmaic-data-export-${userId}.json"`,
    },
  });
}
