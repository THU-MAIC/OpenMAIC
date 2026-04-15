export type AccountType = 'FREE' | 'PLUS' | 'ADMIN';
export type SubscriptionPeriod = 'monthly' | 'yearly' | 'lifetime' | null;

export interface PlanLimits {
  coursesPerMonth: number;      // for FREE: total lifetime cap
  isUnlimited: boolean;
}

export const PLAN_LIMITS: Record<AccountType, PlanLimits> = {
  FREE:  { coursesPerMonth: 2,     isUnlimited: false },
  PLUS:  { coursesPerMonth: 30,    isUnlimited: false },
  ADMIN: { coursesPerMonth: 99999, isUnlimited: true  },
};

export const LIFETIME_MAX_SLOTS = 100;

export interface PricingPlan {
  id: 'monthly' | 'yearly' | 'lifetime';
  label: string;
  price: number;          // in cents
  displayPrice: string;
  period: string;
  stripePriceEnvKey: string;
  savings?: string;
  badge?: string;
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'monthly',
    label: 'Plus Monthly',
    price: 500,
    displayPrice: '$5',
    period: '/month',
    stripePriceEnvKey: 'STRIPE_PRICE_MONTHLY',
  },
  {
    id: 'yearly',
    label: 'Plus Yearly',
    price: 5000,
    displayPrice: '$50',
    period: '/year',
    stripePriceEnvKey: 'STRIPE_PRICE_YEARLY',
    savings: 'Save $10',
    badge: 'Best Value',
  },
  {
    id: 'lifetime',
    label: 'Lifetime',
    price: 10000,
    displayPrice: '$100',
    period: 'one-time',
    stripePriceEnvKey: 'STRIPE_PRICE_LIFETIME',
    badge: 'Limited — 100 spots',
  },
];

export function getStripePriceId(period: 'monthly' | 'yearly' | 'lifetime'): string {
  const plan = PRICING_PLANS.find((p) => p.id === period);
  if (!plan) throw new Error(`Unknown plan period: ${period}`);
  const priceId = process.env[plan.stripePriceEnvKey];
  if (!priceId) throw new Error(`${plan.stripePriceEnvKey} environment variable is not set`);
  return priceId;
}

export interface UserPlan {
  id: string;
  user_id: string;
  account_type: AccountType;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  subscription_status: string | null;
  subscription_period: SubscriptionPeriod;
  current_period_end: string | null;
  courses_generated_total: number;
  courses_generated_month: number;
  courses_month_reset_at: string;
  lifetime_claimed: boolean;
  created_at: string;
  updated_at: string;
}

/** Human-readable summary of remaining credits */
export function getCreditSummary(plan: UserPlan): {
  used: number;
  total: number | 'unlimited';
  remaining: number | 'unlimited';
  resetsAt: string | null;
} {
  if (plan.account_type === 'ADMIN') {
    return { used: plan.courses_generated_total, total: 'unlimited', remaining: 'unlimited', resetsAt: null };
  }
  if (plan.account_type === 'FREE') {
    const used = plan.courses_generated_total;
    const total = 2;
    return { used, total, remaining: Math.max(0, total - used), resetsAt: null };
  }
  // PLUS
  const used = plan.courses_generated_month;
  const total = 30;
  return {
    used,
    total,
    remaining: Math.max(0, total - used),
    resetsAt: plan.courses_month_reset_at,
  };
}
