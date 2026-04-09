import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/db/prisma';

/** GET /api/enrollments — list courses the authenticated user is enrolled in */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const enrollments = await prisma.enrollment.findMany({
    where: { userId: session.user.id },
    include: { course: true },
    orderBy: { enrolledAt: 'desc' },
  });
  return NextResponse.json({ enrollments });
}

/** POST /api/enrollments — enroll the authenticated user in a course */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { courseId, role } = body;
  if (!courseId) return NextResponse.json({ error: 'courseId required' }, { status: 400 });

  const enrollment = await prisma.enrollment.upsert({
    where: { userId_courseId: { userId: session.user.id, courseId } },
    create: { userId: session.user.id, courseId, role: role ?? 'STUDENT' },
    update: {},
  });
  return NextResponse.json({ enrollment });
}
