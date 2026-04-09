import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/db/prisma';

/** GET /api/admin/integrations — list all LMS integrations */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const integrations = await prisma.lMSIntegration.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ integrations });
}

/** POST /api/admin/integrations — create a new integration */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { providerId, name, config } = body;
  if (!providerId || !name) {
    return NextResponse.json({ error: 'providerId and name required' }, { status: 400 });
  }

  const integration = await prisma.lMSIntegration.create({
    data: { providerId, name, config: config || {}, enabled: true },
  });
  return NextResponse.json({ integration });
}
