import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { gradeService } from '@/lib/grading/grade-service';

/** GET /api/grades?courseId=xxx → grades for the authenticated student in a course */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const courseId = searchParams.get('courseId');
  if (!courseId) return NextResponse.json({ error: 'courseId required' }, { status: 400 });

  const grades = await gradeService.getStudentGrades(session.user.id, courseId);
  return NextResponse.json({ grades });
}

/** POST /api/grades — manual grading (teacher only) */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'TEACHER' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { userId, lessonId, sceneId, score, maxScore, feedback } = body;
  if (!userId || !lessonId || score == null) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const grade = await gradeService.recordManualGrade(session.user.id, {
    userId,
    lessonId,
    sceneId,
    score,
    maxScore: maxScore ?? 100,
    feedback,
  });
  return NextResponse.json({ grade });
}
