import { prisma } from '@/lib/auth/prisma';
import { requireRole } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** GET /api/admin/audit-log */
export async function GET(req: NextRequest) {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const limit = Math.min(100, parseInt(searchParams.get('limit') ?? '50'));
  const actorId = searchParams.get('actorId');

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where: actorId ? { actorId } : undefined }),
    prisma.auditLog.findMany({
      where: actorId ? { actorId } : undefined,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        actor: { select: { name: true, email: true } },
        target: { select: { name: true, email: true } },
      },
    }),
  ]);

  return NextResponse.json({ logs, total, page, limit });
}
