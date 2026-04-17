import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** POST /api/user/consent — record PDPA consent */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    undefined;

  await prisma.user.update({
    where: { id: session.user.id },
    data: { consentGiven: true, consentAt: new Date(), consentIp: ip },
  });

  void writeAuditLog({ actorId: session.user.id, action: 'user.consent', resource: 'User', resourceId: session.user.id, req });

  return NextResponse.json({ success: true });
}
