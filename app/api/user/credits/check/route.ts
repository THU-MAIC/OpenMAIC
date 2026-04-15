import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';

/**
 * POST /api/user/credits/check
 * Atomically checks if the user has course-creation credits and
 * increments the counter if allowed.
 *
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function POST(_req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc('increment_course_credit', {
      p_user_id: user.id,
    });

    if (error) {
      console.error('[credits/check] rpc error:', error);
      return NextResponse.json({ error: 'Failed to check credits' }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    console.error('[credits/check] error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
