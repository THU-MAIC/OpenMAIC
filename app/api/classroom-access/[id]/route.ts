import { auth } from '@/lib/auth/auth';
import { userHasClassroomAccess } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: classroomId } = await params;
  const { id: userId, role } = session.user;

  const access = await userHasClassroomAccess(userId, role, classroomId);
  if (!access) return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  return NextResponse.json({ access: true });
}
