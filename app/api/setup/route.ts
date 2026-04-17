import { prisma } from '@/lib/auth/prisma';
import { isSetupComplete } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const MIN_PASSWORD_LENGTH = 10;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])/;

const setupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .regex(PASSWORD_REGEX, 'Password must include uppercase, lowercase, number, and symbol'),
});

/** GET /api/setup — check whether setup is complete */
export async function GET() {
  try {
    const completed = await isSetupComplete();
    return NextResponse.json({ completed });
  } catch {
    // DB not ready yet — signal setup is needed
    return NextResponse.json({ completed: false });
  }
}

/** POST /api/setup — create the first admin account */
export async function POST(req: Request) {
  try {
    const completed = await isSetupComplete();
    if (completed) {
      return NextResponse.json({ error: 'Setup already complete' }, { status: 409 });
    }

    const body = await req.json();
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const { name, email, password } = parsed.data;
    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.$transaction([
      prisma.user.create({
        data: { name, email: email.toLowerCase(), hashedPassword, role: 'ADMIN' },
      }),
      prisma.setupStatus.upsert({
        where: { id: 'singleton' },
        update: { completed: true, completedAt: new Date() },
        create: { id: 'singleton', completed: true, completedAt: new Date() },
      }),
    ]);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Unique constraint')) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Setup failed' }, { status: 500 });
  }
}
