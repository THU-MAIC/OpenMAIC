import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { listCourses, persistCourse } from '@/lib/server/course-storage';
import { getPhilosophyById } from '@/lib/course/philosophies';
import type { CompleteCourse } from '@/lib/types/course';

/** GET /api/courses — list all courses */
export async function GET() {
  const courses = await listCourses();
  return NextResponse.json({ courses });
}

/** POST /api/courses — create a new course */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { title, description, philosophyId, language } = body;
  if (!title || !philosophyId) {
    return NextResponse.json({ error: 'title and philosophyId required' }, { status: 400 });
  }

  const id = `course_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const course: CompleteCourse = {
    id,
    title,
    description,
    philosophyId,
    philosophy: getPhilosophyById(philosophyId),
    modules: [],
    collaborators: [],
    language: language || 'es-MX',
    createdBy: session.user.id,
    createdAt: now,
    updatedAt: now,
  };

  await persistCourse(course);
  return NextResponse.json({ course });
}
