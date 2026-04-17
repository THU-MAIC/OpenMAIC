import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/auth/prisma';
import { requireRole, userOwnsClassroom } from '@/lib/auth/helpers';

/** GET /api/admin/classrooms/[id]/students-search?q=... */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await requireRole('INSTRUCTOR');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id: classroomId } = await params;
  const owns = await userOwnsClassroom(session.user.id, classroomId);
  if (!owns) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) {
    return NextResponse.json({ students: [] });
  }

  const terms = q
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  const searchTerms = terms.length > 0 ? terms : [q];

  const students = await prisma.user.findMany({
    where: {
      role: 'STUDENT',
      AND: searchTerms.map((term) => ({
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { studentId: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
        ],
      })),
    },
    select: {
      id: true,
      name: true,
      studentId: true,
      email: true,
      isActive: true,
    },
    orderBy: [
      { isActive: 'desc' },
      { name: 'asc' },
      { email: 'asc' },
    ],
    take: 20,
  });

  return NextResponse.json({ students });
}
