import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { gradeService } from '@/lib/grading/grade-service';

/** GET /api/grades/[lessonId] — all grades for a lesson (teacher gradebook) */
export async function GET(_req: Request, { params }: { params: Promise<{ lessonId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'TEACHER' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { lessonId } = await params;
  const grades = await gradeService.getLessonGrades(lessonId);
  return NextResponse.json({ grades });
}
