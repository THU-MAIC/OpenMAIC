export type AccountType = 'FREE' | 'PLUS' | 'ULTRA' | 'ADMIN';
export type SubscriptionPeriod = 'monthly' | 'yearly' | 'lifetime' | null;

export interface PlanLimits {
  coursesPerMonth: number;      // for FREE: total lifetime cap
  isUnlimited: boolean;
  canInstantClassroom: boolean; // whether "Instant Classroom" (real-time) is available
}

export const PLAN_LIMITS: Record<AccountType, PlanLimits> = {
  FREE:  { coursesPerMonth: 2,     isUnlimited: false, canInstantClassroom: false },
  PLUS:  { coursesPerMonth: 30,    isUnlimited: false, canInstantClassroom: false },
  ULTRA: { coursesPerMonth: 99999, isUnlimited: true,  canInstantClassroom: true  },
  ADMIN: { coursesPerMonth: 99999, isUnlimited: true,  canInstantClassroom: true  },
};

export const LIFETIME_MAX_SLOTS = 100;

/** Number of courses added per top-up purchase */
export const TOPUP_COURSES_AMOUNT = 10;

export interface PricingPlan {
  id: 'monthly' | 'yearly' | 'lifetime' | 'topup' | 'ultra_monthly' | 'ultra_yearly';
  label: string;
  price: number;          // in cents
  displayPrice: string;
  period: string;
  stripePriceEnvKey: string;
  savings?: string;
  badge?: string;
  tier?: 'plus' | 'ultra';
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'monthly',
    label: 'Plus Monthly',
    price: 500,
    displayPrice: '$5',
    period: '/month',
    stripePriceEnvKey: 'STRIPE_PRICE_MONTHLY',
    tier: 'plus',
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
    tier: 'plus',
  },
  {
    id: 'lifetime',
    label: 'Lifetime',
    price: 10000,
    displayPrice: '$100',
    period: 'one-time',
    stripePriceEnvKey: 'STRIPE_PRICE_LIFETIME',
    badge: 'Limited — 100 spots',
    tier: 'plus',
  },
  {
    id: 'topup',
    label: 'Course Top-Up',
    price: 500,
    displayPrice: '$5',
    period: 'one-time',
    stripePriceEnvKey: 'STRIPE_PRICE_TOPUP',
    badge: '+10 courses',
  },
  {
    id: 'ultra_monthly',
    label: 'Ultra Monthly',
    price: 2000,
    displayPrice: '$20',
    period: '/month',
    stripePriceEnvKey: 'STRIPE_PRICE_ULTRA_MONTHLY',
    badge: 'Instant Classroom',
    tier: 'ultra',
  },
  {
    id: 'ultra_yearly',
    label: 'Ultra Yearly',
    price: 18000,
    displayPrice: '$180',
    period: '/year',
    stripePriceEnvKey: 'STRIPE_PRICE_ULTRA_YEARLY',
    savings: 'Save $60',
    badge: 'Best Value',
    tier: 'ultra',
  },
];

export function getStripePriceId(period: 'monthly' | 'yearly' | 'lifetime' | 'topup' | 'ultra_monthly' | 'ultra_yearly'): string {
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
  extra_credits: number;
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
  if (plan.account_type === 'ADMIN' || plan.account_type === 'ULTRA') {
    return { used: plan.courses_generated_total, total: 'unlimited', remaining: 'unlimited', resetsAt: null };
  }
  if (plan.account_type === 'FREE') {
    const used = plan.courses_generated_total;
    const baseTotal = 2;
    const total = baseTotal + (plan.extra_credits || 0);
    return {
      used,
      total: total,
      remaining: Math.max(0, total - used),
      resetsAt: null,
    };
  }

  // PLUS
  const used = plan.courses_generated_month;
  const baseMonthly = 30;
  // For PLUS, remaining is (monthly cap - monthly used) + any extra credits
  const remaining = Math.max(0, baseMonthly - used) + (plan.extra_credits || 0);

  return {
    used,
    total: baseMonthly + (plan.extra_credits || 0),
    remaining: remaining,
    resetsAt: plan.courses_month_reset_at,
  };
}
