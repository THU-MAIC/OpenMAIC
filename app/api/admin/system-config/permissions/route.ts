import { requireRole } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import { PERMISSION_CATEGORIES } from '@/lib/admin/permissions';

/** GET /api/admin/system-config/permissions */
export async function GET() {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ categories: PERMISSION_CATEGORIES });
}
