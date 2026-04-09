/**
 * LTI Assignment and Grade Services (AGS) push endpoint.
 *
 * Triggered when a grade should be pushed back to the LTI platform.
 * Used by the sync service or directly when a grade is recorded.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { gradeSyncService } from '@/lib/lms/sync-service';

export async function POST(_req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'TEACHER' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = await gradeSyncService.syncPendingGrades();
  return NextResponse.json({ result });
}
