import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('waitlist-count-api');

/** Legacy FastAPI: GET /api/waitlist/count */
export async function GET() {
  try {
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 });
    }

    const { count, error } = await admin.from('waitlist').select('*', { count: 'exact', head: true });

    if (error) {
      log.error('waitlist count failed', error);
      return NextResponse.json({ detail: 'Failed to count waitlist' }, { status: 500 });
    }

    return NextResponse.json({ count: count ?? 0 });
  } catch (e) {
    log.error('waitlist count error', e);
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
