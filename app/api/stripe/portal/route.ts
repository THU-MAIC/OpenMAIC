import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';

/**
 * POST /api/stripe/portal
 * Creates a Stripe Customer Portal session so users can manage
 * their subscription (cancel, update card, view invoices).
 */
export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();
    const { data: plan } = await admin
      .from('user_plans')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single();

    if (!plan?.stripe_customer_id) {
      return NextResponse.json({ error: 'No billing account found' }, { status: 404 });
    }

    const origin = req.headers.get('origin') || process.env.NEXT_PUBLIC_APP_URL || 'https://thechalklabs.com';

    const session = await stripe.billingPortal.sessions.create({
      customer: plan.stripe_customer_id,
      return_url: `${origin}/pricing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[stripe/portal] error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
