import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { progressService } from '@/lib/progress/progress-service';

/** POST /api/progress — update progress for the authenticated student */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { lessonId, sceneIndex, timeSpentDelta, completed } = body;
  if (!lessonId || sceneIndex == null) {
    return NextResponse.json({ error: 'lessonId and sceneIndex required' }, { status: 400 });
  }

  const progress = completed
    ? await progressService.markCompleted(session.user.id, lessonId)
    : await progressService.updateProgress(session.user.id, lessonId, sceneIndex, timeSpentDelta);

  return NextResponse.json({ progress });
}

/** GET /api/progress?courseId=xxx — progress for a student in a course */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const courseId = searchParams.get('courseId');
  if (!courseId) return NextResponse.json({ error: 'courseId required' }, { status: 400 });

  const progress = await progressService.getCourseProgress(session.user.id, courseId);
  return NextResponse.json({ progress });
}
