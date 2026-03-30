import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/server/db';

async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return null;
  if (session.user.role !== 'admin') return null;
  return session;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });

  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ users });
}

export async function PATCH(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });

  const { id, role } = (await req.json()) as { id?: string; role?: string };
  if (!id || !role || !['teacher', 'admin'].includes(role)) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  if (id === session.user.id) {
    return NextResponse.json({ error: 'CANNOT_MODIFY_SELF' }, { status: 400 });
  }

  const user = await prisma.user.update({ where: { id }, data: { role } });
  return NextResponse.json({ user: { id: user.id, role: user.role } });
}

export async function DELETE(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });

  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });

  if (id === session.user.id) {
    return NextResponse.json({ error: 'CANNOT_DELETE_SELF' }, { status: 400 });
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
