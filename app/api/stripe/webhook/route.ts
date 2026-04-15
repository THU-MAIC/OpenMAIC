import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { createAdminClient } from '@/utils/supabase/admin';
import type Stripe from 'stripe';

export const runtime = 'nodejs';

/**
 * POST /api/stripe/webhook
 * Receives Stripe events and keeps user_plans in sync.
 *
 * Required env vars:
 *   STRIPE_WEBHOOK_SECRET  — from `stripe listen --forward-to ...` or the Stripe dashboard
 */
export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: 'Missing stripe-signature or webhook secret' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await req.arrayBuffer();
    event = stripe.webhooks.constructEvent(Buffer.from(rawBody), sig, webhookSecret);
  } catch (err: any) {
    console.error('[stripe/webhook] signature verification failed:', err.message);
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    switch (event.type) {
      // ── Checkout completed ───────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId  = session.metadata?.supabase_user_id;
        const period  = session.metadata?.period as 'monthly' | 'yearly' | 'lifetime' | undefined;

        if (!userId || !period) break;

        if (period === 'lifetime') {
          // Atomically claim a slot; abort if sold out
          const { data: claimed } = await admin.rpc('claim_lifetime_slot');
          if (!claimed) {
            console.error('[stripe/webhook] lifetime sold out — could not fulfil', userId);
            break;
          }

          await admin.from('user_plans').upsert({
            user_id:              userId,
            account_type:         'PLUS',
            stripe_customer_id:   session.customer as string,
            subscription_period:  'lifetime',
            subscription_status:  'active',
            stripe_price_id:      null,
            current_period_end:   null,
            lifetime_claimed:     true,
          }, { onConflict: 'user_id' });

        } else {
          // For subscriptions the subscription object carries the real data;
          // we'll also handle customer.subscription.updated below, so this is a
          // safety net for the very first creation.
          if (session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription as string);
            await upsertSubscription(admin, userId, sub, period);
          }
        }
        break;
      }

      // ── Subscription events ──────────────────────────────────────────────────
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        const period = sub.metadata?.period as 'monthly' | 'yearly' | undefined;
        if (!userId) break;
        await upsertSubscription(admin, userId, sub, period);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;

        // Downgrade to FREE when subscription is fully canceled
        await admin.from('user_plans').upsert({
          user_id:              userId,
          account_type:         'FREE',
          subscription_status:  'canceled',
          subscription_period:  null,
          stripe_subscription_id: sub.id,
          current_period_end:   null,
        }, { onConflict: 'user_id' });
        break;
      }

      // ── Invoice events ───────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        // In Stripe v22 the subscription reference lives at parent.subscription_details.subscription
        const subRef  = invoice.parent?.subscription_details?.subscription;
        const subId   = typeof subRef === 'string' ? subRef : subRef?.id;
        if (!subId) break;

        await admin.from('user_plans')
          .update({ subscription_status: 'past_due' })
          .eq('stripe_subscription_id', subId);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef  = invoice.parent?.subscription_details?.subscription;
        const subId   = typeof subRef === 'string' ? subRef : subRef?.id;
        if (!subId) break;

        // Reset monthly course counter on successful payment
        await admin.from('user_plans')
          .update({
            subscription_status:     'active',
            courses_generated_month: 0,
            courses_month_reset_at:  new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subId);
        break;
      }

      default:
        break;
    }
  } catch (err: any) {
    console.error(`[stripe/webhook] handler error for ${event.type}:`, err);
    // Return 200 so Stripe doesn't retry transient errors
  }

  return NextResponse.json({ received: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function upsertSubscription(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  sub: Stripe.Subscription,
  period?: 'monthly' | 'yearly',
) {
  const priceId      = sub.items.data[0]?.price?.id ?? null;
  // In Stripe v22 the billing anchor is used; we store it as the next period end approximation.
  const periodEndTs  = sub.billing_cycle_anchor;
  const periodEnd    = periodEndTs
    ? new Date(periodEndTs * 1000).toISOString()
    : null;
  const isActive     = ['active', 'trialing'].includes(sub.status);
  const accountType  = isActive ? 'PLUS' : 'FREE';

  await admin.from('user_plans').upsert({
    user_id:                userId,
    account_type:           accountType,
    stripe_customer_id:     typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    stripe_price_id:        priceId,
    subscription_status:    sub.status,
    subscription_period:    period ?? null,
    current_period_end:     periodEnd,
  }, { onConflict: 'user_id' });
}
