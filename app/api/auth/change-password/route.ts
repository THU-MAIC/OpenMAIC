import { NextResponse } from 'next/server';
import { compare, hash } from 'bcryptjs';
import { auth } from '@/auth';
import { prisma } from '@/lib/server/db';

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const { currentPassword, newPassword } = (await req.json()) as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: 'PASSWORD_TOO_SHORT' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) return NextResponse.json({ error: 'USER_NOT_FOUND' }, { status: 404 });

  const valid = await compare(currentPassword, user.password);
  if (!valid) return NextResponse.json({ error: 'WRONG_CURRENT_PASSWORD' }, { status: 400 });

  const hashed = await hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

  return NextResponse.json({ success: true });
}
