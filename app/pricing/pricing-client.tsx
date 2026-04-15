'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { Check, Zap, Crown, Shield, BookOpen, Sparkles, Clock, Users, MessageCircle, Headphones } from 'lucide-react';
import { toast } from 'sonner';
import { LIFETIME_MAX_SLOTS } from '@/lib/stripe/plans';
import type { UserPlan, SubscriptionPeriod } from '@/lib/stripe/plans';
import { UpgradeSuccessModal } from '@/components/billing/upgrade-success-modal';

// ── Feature rows ──────────────────────────────────────────────────────────────

const FEATURES: { label: string; free: boolean | string; plus: boolean | string; lifetime: boolean | string }[] = [
  { label: 'AI course generation', free: true, plus: true, lifetime: true },
  { label: 'Course credits', free: '2 total', plus: '30 / mo', lifetime: '30 / mo' },
  { label: 'Cloud course storage', free: true, plus: true, lifetime: true },
  { label: 'Quizzes & leaderboard', free: true, plus: true, lifetime: true },
  { label: 'PDF & web-search input', free: true, plus: true, lifetime: true },
  { label: 'Slate community access', free: false, plus: true, lifetime: true },
  { label: 'Priority generation', free: false, plus: true, lifetime: true },
  { label: '1-on-1 support', free: false, plus: false, lifetime: true },
  { label: 'Billing management', free: false, plus: true, lifetime: false },
];

function FeatureCheck({ value, lifetime }: { value: boolean | string; lifetime?: boolean }) {
  if (value === false) return <span className="text-[#073b4c]/20 font-bold text-lg leading-none">—</span>;
  if (value === true)
    return <Check className={`size-4 stroke-[3] ${lifetime ? 'text-[#ffd166]' : 'text-[#06D6A0]'}`} />;
  return <span className="text-xs font-bold text-[#073b4c]">{value}</span>;
}

export function PricingClient() {
  const searchParams = useSearchParams();
  const [plan, setPlan] = useState<UserPlan | null>(null);
  const [lifetimeSlots, setSlots] = useState<{ taken: number; max: number } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [successModal, setSuccessModal] = useState<{ open: boolean; period: SubscriptionPeriod }>({
    open: false,
    period: null,
  });

  // Show success modal (or toast) on redirect back from Stripe
  useEffect(() => {
    const successParam = searchParams.get('success');
    const periodParam = searchParams.get('period') as SubscriptionPeriod | null;
    const topupParam = searchParams.get('topup');

    if (successParam) {
      // Delay slightly so plan fetch can complete first
      const timer = setTimeout(() => {
        setSuccessModal({ open: true, period: periodParam ?? 'monthly' });
      }, 600);
      return () => clearTimeout(timer);
    } else if (topupParam === 'success') {
      toast.success('10 courses added to your account! Happy learning 🎉');
    } else if (searchParams.get('canceled')) {
      toast.info('Checkout canceled — no charge was made.');
    }
  }, [searchParams]);

  // Fetch current user plan & lifetime slot count
  useEffect(() => {
    fetch('/api/user/plan')
      .then((r) => r.json())
      .then((j) => {
        if (j.success) setPlan(j.plan);
      })
      .catch(() => {});

    fetch('/api/lifetime-slots')
      .then((r) => r.json())
      .then((j) => {
        if (j.slots) setSlots(j.slots);
      })
      .catch(() => {});
  }, []);

  const handleCheckout = async (period: 'monthly' | 'yearly' | 'lifetime') => {
    setLoading(period);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Checkout failed');
      if (json.url) window.location.href = json.url;
    } catch (err: any) {
      toast.error(err.message || 'Something went wrong');
    } finally {
      setLoading(null);
    }
  };

  const handlePortal = async () => {
    setLoading('portal');
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Portal failed');
      if (json.url) window.open(json.url, '_blank');
    } catch (err: any) {
      toast.error(err.message || 'Something went wrong');
    } finally {
      setLoading(null);
    }
  };

  const currentPeriod = plan?.subscription_period;
  const isPlus = plan?.account_type === 'PLUS';
  const isAdmin = plan?.account_type === 'ADMIN';

  const slotsLeft = lifetimeSlots ? lifetimeSlots.max - lifetimeSlots.taken : LIFETIME_MAX_SLOTS;

  return (
    <>
    <UpgradeSuccessModal
      open={successModal.open}
      period={successModal.period}
      onClose={() => setSuccessModal((s) => ({ ...s, open: false }))}
    />
    <main className="min-h-screen bg-[#f0f4f8] py-16 px-4">
      {/* ── Hero ── */}
      <div className="text-center mb-14">
        <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 mb-5 rounded-full border-2 border-[#118AB2]/20 bg-[#118AB2]/5 text-xs font-black text-[#118AB2] uppercase tracking-widest">
            <Sparkles className="size-3" /> Simple Pricing
          </span>
          <h1 className="text-5xl font-black text-[#073b4c] leading-tight mb-3">
            Build smarter.
            <br />
            Learn faster.
          </h1>
          <p className="text-[#073b4c]/50 text-lg max-w-md mx-auto">Start free. Upgrade when you need more. Cancel anytime.</p>
        </motion.div>
      </div>

      {/* ── Plan cards ── */}
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
        {/* FREE */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="relative rounded-3xl border-[3px] border-[#073b4c]/10 bg-white p-7 flex flex-col"
        >
          <div className="flex items-center gap-2 mb-5">
            <div className="size-8 rounded-xl bg-[#f0f4f8] border-2 border-[#073b4c]/10 flex items-center justify-center">
              <BookOpen className="size-4 text-[#073b4c]/60" />
            </div>
            <div>
              <p className="text-xs font-black text-[#073b4c]/40 uppercase tracking-widest">Current</p>
              <h2 className="text-lg font-black text-[#073b4c]">Free</h2>
            </div>
          </div>

          <div className="mb-6">
            <span className="text-4xl font-black text-[#073b4c]">$0</span>
            <span className="text-[#073b4c]/30 text-sm ml-1">forever</span>
          </div>

          <ul className="space-y-2.5 mb-8 flex-1">
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#06D6A0] stroke-[3] shrink-0" />2 AI course credits
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#06D6A0] stroke-[3] shrink-0" />
              Cloud storage & quizzes
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#06D6A0] stroke-[3] shrink-0" />
              Leaderboard & analytics
            </li>
          </ul>

          <div className="h-11 rounded-2xl border-[3px] border-[#073b4c]/15 bg-[#f0f4f8] text-[#073b4c]/40 font-bold text-sm flex items-center justify-center">
            Your current plan
          </div>
        </motion.div>

        {/* PLUS MONTHLY */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="relative rounded-3xl border-[3px] border-[#118AB2] bg-white p-7 flex flex-col shadow-[6px_6px_0_#118AB2]"
        >
          {isPlus && currentPeriod === 'monthly' && (
            <div className="absolute -top-3 left-5 px-3 py-0.5 bg-[#118AB2] rounded-full text-white text-[10px] font-black uppercase tracking-widest">
              Active
            </div>
          )}

          <div className="flex items-center gap-2 mb-5">
            <div className="size-8 rounded-xl bg-[#118AB2]/10 border-2 border-[#118AB2]/20 flex items-center justify-center">
              <Zap className="size-4 text-[#118AB2]" />
            </div>
            <div>
              <p className="text-xs font-black text-[#118AB2]/60 uppercase tracking-widest">Plus</p>
              <h2 className="text-lg font-black text-[#073b4c]">Monthly</h2>
            </div>
          </div>

          <div className="mb-6">
            <span className="text-4xl font-black text-[#073b4c]">$5</span>
            <span className="text-[#073b4c]/30 text-sm ml-1">/ month</span>
          </div>

          <ul className="space-y-2.5 mb-8 flex-1">
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#118AB2] stroke-[3] shrink-0" />
              <strong>30 courses/month</strong>
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#118AB2] stroke-[3] shrink-0" />
              Monthly credit reset
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#118AB2] stroke-[3] shrink-0" />
              Everything in Free
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <MessageCircle className="size-3.5 text-[#118AB2] shrink-0" />
              Slate community access
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#118AB2] stroke-[3] shrink-0" />
              Cancel anytime
            </li>
          </ul>

          {isPlus && currentPeriod === 'monthly' ? (
            <button
              onClick={handlePortal}
              disabled={loading === 'portal'}
              className="h-11 rounded-2xl border-[3px] border-[#118AB2] text-[#118AB2] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#118AB2]/5 transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading === 'portal' ? 'Loading…' : 'Manage Subscription'}
            </button>
          ) : (
            <button
              onClick={() => handleCheckout('monthly')}
              disabled={!!loading || isAdmin}
              className="h-11 rounded-2xl border-[3px] border-[#118AB2] bg-[#118AB2] text-white font-bold text-sm flex items-center justify-center hover:bg-[#0e7aa0] hover:shadow-[4px_4px_0_#073b4c] transition-all cursor-pointer disabled:opacity-50 shadow-[3px_3px_0_#073b4c]"
            >
              {loading === 'monthly' ? 'Redirecting…' : 'Get Monthly'}
            </button>
          )}
        </motion.div>

        {/* PLUS YEARLY */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="relative rounded-3xl border-[3px] border-[#06D6A0] bg-white p-7 flex flex-col shadow-[6px_6px_0_#06D6A0]"
        >
          <div className="absolute -top-3 right-5 px-3 py-0.5 bg-[#06D6A0] rounded-full text-[#073b4c] text-[10px] font-black uppercase tracking-widest">
            {isPlus && currentPeriod === 'yearly' ? 'Active' : 'Best Value'}
          </div>

          <div className="flex items-center gap-2 mb-5">
            <div className="size-8 rounded-xl bg-[#06D6A0]/10 border-2 border-[#06D6A0]/20 flex items-center justify-center">
              <Zap className="size-4 text-[#06D6A0]" />
            </div>
            <div>
              <p className="text-xs font-black text-[#06D6A0]/70 uppercase tracking-widest">Plus</p>
              <h2 className="text-lg font-black text-[#073b4c]">Yearly</h2>
            </div>
          </div>

          <div className="mb-1">
            <span className="text-4xl font-black text-[#073b4c]">$50</span>
            <span className="text-[#073b4c]/30 text-sm ml-1">/ year</span>
          </div>
          <p className="text-xs font-bold text-[#06D6A0] mb-5">Save $10 vs monthly</p>

          <ul className="space-y-2.5 mb-8 flex-1">
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#06D6A0] stroke-[3] shrink-0" />
              <strong>30 courses/month</strong>
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#06D6A0] stroke-[3] shrink-0" />
              Annual billing (save $10)
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <Check className="size-3.5 text-[#06D6A0] stroke-[3] shrink-0" />
              Everything in Free
            </li>
            <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
              <MessageCircle className="size-3.5 text-[#06D6A0] shrink-0" />
              Slate community access
            </li>
          </ul>

          {isPlus && currentPeriod === 'yearly' ? (
            <button
              onClick={handlePortal}
              disabled={loading === 'portal'}
              className="h-11 rounded-2xl border-[3px] border-[#06D6A0] text-[#06D6A0] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#06D6A0]/5 transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading === 'portal' ? 'Loading…' : 'Manage Subscription'}
            </button>
          ) : (
            <button
              onClick={() => handleCheckout('yearly')}
              disabled={!!loading || isAdmin}
              className="h-11 rounded-2xl border-[3px] border-[#06D6A0] bg-[#06D6A0] text-[#073b4c] font-bold text-sm flex items-center justify-center hover:bg-[#04b889] hover:shadow-[4px_4px_0_#073b4c] transition-all cursor-pointer disabled:opacity-50 shadow-[3px_3px_0_#073b4c]"
            >
              {loading === 'yearly' ? 'Redirecting…' : 'Get Yearly'}
            </button>
          )}
        </motion.div>
      </div>

      {/* ── Lifetime offer ── */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35 }}
        className="max-w-2xl mx-auto mb-16"
      >
        <div className="relative rounded-3xl border-[3px] border-[#ffd166] bg-gradient-to-br from-[#fff9e6] to-white p-8 shadow-[6px_6px_0_#ffd166]">
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-1 bg-[#ffd166] rounded-full border-2 border-[#073b4c]/10 shadow">
            <Crown className="size-3.5 text-[#073b4c]" />
            <span className="text-xs font-black text-[#073b4c] uppercase tracking-widest">Limited Lifetime Offer</span>
          </div>

          <div className="flex flex-col md:flex-row items-center gap-8 pt-2">
            <div className="flex-1">
              <h3 className="text-2xl font-black text-[#073b4c] mb-1">Pay Once. Use Forever.</h3>
              <p className="text-[#073b4c]/50 text-sm mb-4">
                One-time payment. 30 courses/month, every month — no subscription required.
              </p>

              <ul className="space-y-1.5 mb-4">
                <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
                  <Check className="size-3.5 text-[#ffd166] stroke-[3] shrink-0" />
                  <strong>30 courses/month</strong>, forever
                </li>
                <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
                  <MessageCircle className="size-3.5 text-[#ffd166] shrink-0" />
                  Slate community access
                </li>
                <li className="flex items-center gap-2 text-sm text-[#073b4c]/70">
                  <Headphones className="size-3.5 text-[#ffd166] shrink-0" />
                  <span>
                    <strong>1-on-1 support</strong> from the team
                  </span>
                </li>
              </ul>

              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#073b4c]/60">
                  <Users className="size-3.5" />
                  <span>
                    <span className="text-[#ef476f] font-black">{slotsLeft}</span> of {LIFETIME_MAX_SLOTS} spots left
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#073b4c]/60">
                  <Clock className="size-3.5" />
                  No recurring fees
                </div>
              </div>

              {/* Slot progress bar */}
              <div className="w-full h-2 rounded-full bg-[#073b4c]/10 overflow-hidden mb-1">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#ffd166] to-[#ef476f] transition-all duration-700"
                  style={{ width: `${Math.min(100, ((LIFETIME_MAX_SLOTS - slotsLeft) / LIFETIME_MAX_SLOTS) * 100)}%` }}
                />
              </div>
              <p className="text-[9px] text-[#073b4c]/30 mb-5">
                {LIFETIME_MAX_SLOTS - slotsLeft} of {LIFETIME_MAX_SLOTS} lifetime spots claimed
              </p>
            </div>

            <div className="shrink-0 text-center">
              <div className="mb-2">
                <span className="text-5xl font-black text-[#073b4c]">$100</span>
                <p className="text-xs text-[#073b4c]/40 font-semibold">one-time</p>
              </div>

              {isPlus && currentPeriod === 'lifetime' ? (
                <div className="px-6 py-2.5 rounded-2xl bg-[#ffd166] border-[3px] border-[#073b4c]/20 font-black text-sm text-[#073b4c]">
                  ✓ You own this
                </div>
              ) : slotsLeft <= 0 ? (
                <div className="px-6 py-2.5 rounded-2xl bg-[#f0f4f8] border-[3px] border-[#073b4c]/10 font-black text-sm text-[#073b4c]/40">
                  Sold Out
                </div>
              ) : (
                <button
                  onClick={() => handleCheckout('lifetime')}
                  disabled={!!loading || isAdmin}
                  className="px-8 py-2.5 rounded-2xl border-[3px] border-[#073b4c] bg-[#073b4c] text-white font-black text-sm hover:bg-[#118AB2] hover:border-[#118AB2] hover:shadow-[4px_4px_0_#073b4c] transition-all cursor-pointer disabled:opacity-50 shadow-[3px_3px_0_#ffd166]"
                >
                  {loading === 'lifetime' ? 'Redirecting…' : 'Claim Lifetime Access'}
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── Feature comparison table ── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.45 }} className="max-w-3xl mx-auto mb-12">
        <h3 className="text-center text-xs font-black text-[#073b4c]/30 uppercase tracking-widest mb-5">What's included</h3>
        <div className="rounded-3xl border-[3px] border-[#073b4c]/10 bg-white overflow-hidden">
          <div className="grid grid-cols-4 border-b-[3px] border-[#073b4c]/5 px-6 py-3">
            <span className="text-xs font-black text-[#073b4c]/30 uppercase tracking-widest">Feature</span>
            <span className="text-xs font-black text-[#073b4c]/40 uppercase tracking-widest text-center">Free</span>
            <span className="text-xs font-black text-[#118AB2] uppercase tracking-widest text-center">Plus</span>
            <span className="text-xs font-black text-[#ffd166] uppercase tracking-widest text-center">Lifetime</span>
          </div>
          {FEATURES.map((f, i) => (
            <div
              key={f.label}
              className={`grid grid-cols-4 items-center px-6 py-3.5 ${i < FEATURES.length - 1 ? 'border-b border-[#073b4c]/5' : ''} ${f.label === '1-on-1 support' ? 'bg-[#fff9e6]/60' : ''}`}
            >
              <span className="text-sm text-[#073b4c]/70 font-medium flex items-center gap-1.5">
                {f.label === '1-on-1 support' && <Headphones className="size-3.5 text-[#ffd166] shrink-0" />}
                {f.label === 'Slate community access' && <MessageCircle className="size-3.5 text-[#118AB2] shrink-0" />}
                {f.label}
              </span>
              <div className="flex justify-center">
                <FeatureCheck value={f.free} />
              </div>
              <div className="flex justify-center">
                <FeatureCheck value={f.plus} />
              </div>
              <div className="flex justify-center">
                <FeatureCheck value={f.lifetime} lifetime />
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── Admin note ── */}
      {isAdmin && (
        <div className="max-w-md mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#06D6A0]/10 border-2 border-[#06D6A0]/20 text-[#06D6A0] text-xs font-black">
            <Shield className="size-3.5" /> Admin — unlimited access
          </div>
        </div>
      )}
    </main>
    </>
  );
}

