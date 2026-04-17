import { prisma } from '@/lib/auth/prisma';
import { requireRole } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const page = Math.max(1, parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10));
  const limit = Math.min(100, parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10));

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where: { OR: [{ actorId: id }, { targetId: id }] } }),
    prisma.auditLog.findMany({
      where: { OR: [{ actorId: id }, { targetId: id }] },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        actor: { select: { id: true, name: true, email: true } },
        target: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  return NextResponse.json({ logs, total, page, limit });
}
