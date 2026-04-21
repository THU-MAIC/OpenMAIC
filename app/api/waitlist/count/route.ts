import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('waitlist-count-api');

/** Legacy FastAPI: GET /api/waitlist/count */
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = new Set(['https://slateup.ai', 'https://www.slateup.ai']);

  const headers = new Headers();
  if (origin && allowed.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    headers.set(
      'Access-Control-Allow-Headers',
      request.headers.get('access-control-request-headers') ?? 'Content-Type, Authorization',
    );
    headers.set('Access-Control-Max-Age', '86400');
  }

  return new NextResponse(null, { status: 204, headers });
}

export async function GET(request: Request) {
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

    const origin = request.headers.get('origin');
    const allowed = new Set(['https://slateup.ai', 'https://www.slateup.ai']);

    const res = NextResponse.json({ count: count ?? 0 });
    if (origin && allowed.has(origin)) {
      res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.set('Vary', 'Origin');
    }
    return res;
  } catch (e) {
    log.error('waitlist count error', e);
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
