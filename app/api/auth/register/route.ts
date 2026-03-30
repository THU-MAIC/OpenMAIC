import { NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/server/db';

export async function POST(req: Request) {
  const body = await req.json();
  const { email, password, name } = body as { email?: string; password?: string; name?: string };

  if (!email || !password) {
    return NextResponse.json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'PASSWORD_TOO_SHORT' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'EMAIL_TAKEN' }, { status: 409 });
  }

  const hashed = await hash(password, 12);
  await prisma.user.create({
    data: { email, password: hashed, name: name || null, role: 'teacher' },
  });

  return NextResponse.json({ success: true }, { status: 201 });
}
