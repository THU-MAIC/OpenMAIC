import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { getStripePriceId } from '@/lib/stripe/plans';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';

/**
 * POST /api/stripe/topup
 * Creates a one-time Stripe Checkout session for the course top-up product.
 * Adds TOPUP_COURSES_AMOUNT (10) courses to the user's account on completion.
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

    // Fetch or create Stripe customer for this user
    const { data: plan } = await admin
      .from('user_plans')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single();

    let customerId = plan?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.user_metadata?.full_name || user.user_metadata?.name || undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      await admin
        .from('user_plans')
        .upsert({ user_id: user.id, stripe_customer_id: customer.id }, { onConflict: 'user_id' });
    }

    const priceId = getStripePriceId('topup');
    const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${origin}/pricing?topup=success`,
      cancel_url: `${origin}/pricing?canceled=true`,
      metadata: {
        supabase_user_id: user.id,
        type: 'topup',
      },
      allow_promotion_codes: true,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[stripe/topup] error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
