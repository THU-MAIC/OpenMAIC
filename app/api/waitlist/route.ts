import { type NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { randomUUID } from 'crypto';
import { createAdminClient } from '@/utils/supabase/admin';
import { sendWelcomeEmail } from '@/lib/server/waitlist-sendgrid';
import { createLogger } from '@/lib/logger';

const log = createLogger('waitlist-api');

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  return email;
}

/** Legacy FastAPI: POST /api/waitlist */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = normalizeEmail(body?.email);
    if (!email) {
      return NextResponse.json({ detail: 'Invalid email address' }, { status: 400 });
    }

    let admin;
    try {
      admin = createAdminClient();
    } catch {
      log.error('Supabase admin client not configured');
      return NextResponse.json(
        { detail: 'Server is not configured for waitlist' },
        { status: 503 },
      );
    }

    const { data: existing } = await admin.from('waitlist').select('id').eq('email', email).maybeSingle();

    if (existing) {
      return NextResponse.json({
        status: 'success',
        message: "You're already on the waitlist!",
      });
    }

    const id = randomUUID();
    const joinedAt = new Date().toISOString();

    const { error: insertError } = await admin.from('waitlist').insert({
      id,
      email,
      joined_at: joinedAt,
    });

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json({
          status: 'success',
          message: "You're already on the waitlist!",
        });
      }
      log.error('waitlist insert failed', insertError);
      return NextResponse.json({ detail: 'Failed to join waitlist' }, { status: 500 });
    }

    after(() => {
      void sendWelcomeEmail(email);
    });

    return NextResponse.json({
      status: 'success',
      message: 'Welcome to the SLATE UP waitlist! Check your email.',
    });
  } catch (e) {
    log.error('waitlist POST error', e);
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
