import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { readCourse, persistCourse, deleteCourse } from '@/lib/server/course-storage';
import { getPhilosophyById } from '@/lib/course/philosophies';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const course = await readCourse(id);
  if (!course) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Re-embed philosophy at read time
  course.philosophy = getPhilosophyById(course.philosophyId);
  return NextResponse.json({ course });
}

export async function PUT(req: Request, { params }: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const existing = await readCourse(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Only the creator or admins can edit
  if (existing.createdBy && existing.createdBy !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const updated = { ...existing, ...body, id, updatedAt: Date.now() };
  await persistCourse(updated);
  return NextResponse.json({ course: updated });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const existing = await readCourse(id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (existing.createdBy && existing.createdBy !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await deleteCourse(id);
  return NextResponse.json({ ok: true });
}
