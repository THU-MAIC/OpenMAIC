import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { getStripePriceId, LIFETIME_MAX_SLOTS } from '@/lib/stripe/plans';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';

/**
 * POST /api/stripe/checkout
 * Creates a Stripe Checkout session for the given plan period.
 *
 * Body: { period: 'monthly' | 'yearly' | 'lifetime' }
 */
export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { period } = await req.json() as { period: 'monthly' | 'yearly' | 'lifetime' };

    if (!['monthly', 'yearly', 'lifetime'].includes(period)) {
      return NextResponse.json({ error: 'Invalid plan period' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Check lifetime slot availability before proceeding
    if (period === 'lifetime') {
      const { data: slots } = await admin
        .from('lifetime_slots')
        .select('slots_taken, max_slots')
        .eq('id', 1)
        .single();

      if (slots && slots.slots_taken >= slots.max_slots) {
        return NextResponse.json({ error: 'Lifetime plan is sold out' }, { status: 409 });
      }
    }

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

    const priceId = getStripePriceId(period);
    const origin = req.headers.get('origin') || process.env.NEXT_PUBLIC_APP_URL || 'https://thechalklabs.com';

    const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: period === 'lifetime' ? 'payment' : 'subscription',
      success_url: `${origin}/pricing?success=true&period=${period}`,
      cancel_url: `${origin}/pricing?canceled=true`,
      metadata: {
        supabase_user_id: user.id,
        period,
      },
      allow_promotion_codes: true,
    };

    // For subscriptions attach the customer update to keep billing info synced
    if (period !== 'lifetime') {
      sessionParams.subscription_data = {
        metadata: { supabase_user_id: user.id, period },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[stripe/checkout] error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
