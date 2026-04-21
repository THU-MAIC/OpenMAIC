import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createAdminClient } from '@/utils/supabase/admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('status-checks-api');

function parseClientName(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const name = (body as { client_name?: unknown }).client_name;
  if (typeof name !== 'string' || !name.trim()) return null;
  return name.trim();
}

/** Legacy FastAPI: POST /api/status */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const clientName = parseClientName(body);
    if (!clientName) {
      return NextResponse.json({ detail: 'client_name is required' }, { status: 422 });
    }

    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 });
    }

    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const { error } = await admin.from('status_checks').insert({
      id,
      client_name: clientName,
      timestamp,
    });

    if (error) {
      log.error('status_checks insert failed', error);
      return NextResponse.json({ detail: 'Failed to save status' }, { status: 500 });
    }

    return NextResponse.json({
      id,
      client_name: clientName,
      timestamp,
    });
  } catch (e) {
    log.error('status POST error', e);
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}

/** Legacy FastAPI: GET /api/status */
export async function GET() {
  try {
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 });
    }

    const { data, error } = await admin
      .from('status_checks')
      .select('id, client_name, timestamp')
      .order('timestamp', { ascending: false })
      .limit(1000);

    if (error) {
      log.error('status_checks select failed', error);
      return NextResponse.json({ detail: 'Failed to load status checks' }, { status: 500 });
    }

    const rows = (data ?? []).map((row) => ({
      id: row.id,
      client_name: row.client_name,
      timestamp:
        typeof row.timestamp === 'string'
          ? row.timestamp
          : row.timestamp
            ? new Date(row.timestamp).toISOString()
            : null,
    }));

    return NextResponse.json(rows);
  } catch (e) {
    log.error('status GET error', e);
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
