import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { readCourse, persistCourse } from '@/lib/server/course-storage';
import type { CourseModule } from '@/lib/types/course';

interface Ctx {
  params: Promise<{ id: string }>;
}

/** POST /api/courses/[id]/modules — add a module to a course */
export async function POST(req: Request, { params }: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const course = await readCourse(id);
  if (!course) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json();
  const module: CourseModule = {
    id: `mod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    courseId: id,
    title: body.title || 'Nuevo módulo',
    description: body.description,
    order: course.modules.length,
    stageIds: body.stageIds || [],
    objectives: body.objectives,
    estimatedDuration: body.estimatedDuration,
  };

  course.modules.push(module);
  course.updatedAt = Date.now();
  await persistCourse(course);
  return NextResponse.json({ module });
}
