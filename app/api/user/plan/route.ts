import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { getCreditSummary } from '@/lib/stripe/plans';
import type { UserPlan } from '@/lib/stripe/plans';

/**
 * GET /api/user/plan
 * Returns the authenticated user's current plan and credit usage.
 */
export async function GET(_req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();

    // Upsert to guarantee the row exists for new users
    const { data: plan, error } = await admin
      .from('user_plans')
      .upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true })
      .select()
      .single();

    if (error) {
      // Row already exists — fetch it
      const { data: existing, error: fetchErr } = await admin
        .from('user_plans')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (fetchErr || !existing) {
        return NextResponse.json({ error: 'Failed to fetch plan' }, { status: 500 });
      }

      const credits = getCreditSummary(existing as UserPlan);
      return NextResponse.json({ success: true, plan: existing, credits });
    }

    const credits = getCreditSummary(plan as UserPlan);
    return NextResponse.json({ success: true, plan, credits });
  } catch (err: any) {
    console.error('[user/plan] error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
