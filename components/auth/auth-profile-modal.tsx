'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, LogOut, Mail, Zap, Crown, Shield, BookOpen, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/hooks/use-auth';
import { LeaderboardCard } from '../leaderboard/leaderboard-card';
import type { UserPlan } from '@/lib/stripe/plans';

interface AuthProfileModalProps {
  open: boolean;
  onClose: () => void;
}

// ── Plan & Credits sub-component ─────────────────────────────────────────────

const ACCOUNT_META: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  FREE:  { label: 'Free',  color: '#073b4c', bg: '#f0f4f8', icon: <BookOpen className="size-3" /> },
  PLUS:  { label: 'Plus',  color: '#118AB2', bg: '#e8f6fd', icon: <Zap className="size-3" /> },
  ADMIN: { label: 'Admin', color: '#06D6A0', bg: '#e6fdf7', icon: <Shield className="size-3" /> },
};

function PlanCreditsSection({
  plan,
  credits,
  onClose,
}: {
  plan: UserPlan | null;
  credits: any;
  onClose: () => void;
}) {
  if (!plan) {
    return (
      <div className="mb-4 h-20 rounded-2xl bg-[#f0f4f8] animate-pulse" />
    );
  }

  const meta   = ACCOUNT_META[plan.account_type] ?? ACCOUNT_META.FREE;
  const isPaid = plan.account_type === 'PLUS' || plan.account_type === 'ADMIN';

  const used      = credits?.used   ?? 0;
  const total     = credits?.total  ?? (plan.account_type === 'FREE' ? 2 : 30);
  const remaining = credits?.remaining ?? (total === 'unlimited' ? 'unlimited' : Math.max(0, (total as number) - used));
  const pct       = total === 'unlimited' ? 0 : Math.min(100, Math.round((used / (total as number)) * 100));

  const handleUpgrade = () => {
    onClose();
    window.location.href = '/pricing';
  };

  const handleManageBilling = async () => {
    const res  = await fetch('/api/stripe/portal', { method: 'POST' });
    const json = await res.json();
    if (json.url) window.open(json.url, '_blank');
  };

  return (
    <div className="mb-4">
      <h4 className="text-[11px] font-black text-[#073b4c]/30 uppercase tracking-widest mb-2 px-1">Plan & Credits</h4>

      {/* Account type badge */}
      <div
        className="flex items-center justify-between rounded-2xl border-2 px-3 py-2.5 mb-2"
        style={{ borderColor: `${meta.color}20`, backgroundColor: meta.bg }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: meta.color }}>{meta.icon}</span>
          <span className="text-xs font-black" style={{ color: meta.color }}>{meta.label}</span>
          {plan.subscription_period && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize"
              style={{ background: `${meta.color}18`, color: meta.color }}>
              {plan.subscription_period}
            </span>
          )}
        </div>
        {!isPaid && (
          <button
            onClick={handleUpgrade}
            className="flex items-center gap-1 text-[10px] font-black text-[#118AB2] hover:text-[#073b4c] transition-colors"
          >
            <Crown className="size-3" /> Upgrade
          </button>
        )}
        {isPaid && plan.subscription_period !== 'lifetime' && (
          <button
            onClick={handleManageBilling}
            className="flex items-center gap-1 text-[10px] font-semibold text-[#073b4c]/40 hover:text-[#073b4c] transition-colors"
          >
            Manage <ExternalLink className="size-2.5" />
          </button>
        )}
      </div>

      {/* Credit usage bar */}
      <div className="bg-[#f0f4f8] rounded-2xl border-2 border-[#073b4c]/5 px-3 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-black text-[#073b4c]/50 uppercase tracking-tighter">
            {plan.account_type === 'FREE' ? 'Course Credits (Lifetime)' : 'Courses This Month'}
          </span>
          <span className="text-[10px] font-black text-[#073b4c]">
            {remaining === 'unlimited' ? '∞ unlimited' : `${remaining} left`}
          </span>
        </div>

        {total !== 'unlimited' ? (
          <>
            <div className="w-full h-1.5 rounded-full bg-[#073b4c]/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${pct}%`,
                  backgroundColor: pct >= 90 ? '#ef476f' : pct >= 60 ? '#ffd166' : '#06D6A0',
                }}
              />
            </div>
            <p className="text-[9px] text-[#073b4c]/30 mt-1">
              {used} of {total as number} used
            </p>
          </>
        ) : (
          <p className="text-[10px] text-[#06D6A0] font-black">Unlimited access</p>
        )}

        {!isPaid && (remaining as number) <= 0 && (
          <button
            onClick={handleUpgrade}
            className="mt-2 w-full h-7 rounded-xl bg-[#073b4c] text-white text-[10px] font-black hover:bg-[#118AB2] transition-colors"
          >
            Upgrade to Plus — 30 courses/month
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Profile modal that slides in from the top-right when the user clicks
 * their profile button. Shows basic account info and a sign-out button.
 * Matches Slate's neubrutalist design language.
 */
export function AuthProfileModal({ open, onClose }: AuthProfileModalProps) {
  const { user, signOut } = useAuth();
  const panelRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<any>(null);
  const [plan, setPlan] = useState<UserPlan | null>(null);
  const [credits, setCredits] = useState<any>(null);

  useEffect(() => {
    if (open && user) {
      fetch('/api/analytics/user-stats')
        .then(res => res.json())
        .then(json => { if (json.success) setStats(json.stats); })
        .catch(err => console.error('Failed to fetch stats:', err));

      fetch('/api/user/plan')
        .then(res => res.json())
        .then(json => {
          if (json.success) {
            setPlan(json.plan);
            setCredits(json.credits);
          }
        })
        .catch(err => console.error('Failed to fetch plan:', err));
    }
  }, [open, user]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener so the opening click doesn't immediately close
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleSignOut = async () => {
    await signOut();
    onClose();
    window.location.href = '/';
  };

  if (!user) return null;

  // Extract user info
  const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture;
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name || '';
  const email = user.email || '';
  const createdAt = user.created_at ? new Date(user.created_at) : null;
  const provider = user.app_metadata?.provider || 'email';
  const initials = fullName
    ? fullName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : email.slice(0, 2).toUpperCase();

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[99] bg-black/10 backdrop-blur-[2px]"
            aria-hidden
          />

          {/* Panel */}
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.95 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="fixed top-16 right-4 z-[100] w-[320px] rounded-3xl border-[3px] border-[#073b4c] bg-white shadow-[6px_6px_0_#073b4c]"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
              <h3 className="text-sm font-black text-[#073b4c] tracking-tight">Your Profile</h3>
              <button
                onClick={onClose}
                className="size-7 rounded-full border-2 border-[#073b4c]/20 flex items-center justify-center hover:bg-[#f0f4f8] hover:border-[#073b4c]/40 transition-all cursor-pointer"
              >
                <X className="size-3.5 text-[#073b4c]/60" />
              </button>
            </div>

            {/* User info */}
            <div className="px-5 pb-4">
              <div className="flex items-center gap-3.5 mb-4">
                {/* Avatar */}
                {avatarUrl ? (
                  <div className="size-14 rounded-2xl border-[3px] border-[#073b4c] overflow-hidden shadow-[3px_3px_0_#073b4c] shrink-0">
                    <img src={avatarUrl} alt="" className="size-full object-cover" />
                  </div>
                ) : (
                  <div className="size-14 rounded-2xl border-[3px] border-[#073b4c] bg-gradient-to-br from-[#118AB2] to-[#06D6A0] shadow-[3px_3px_0_#073b4c] flex items-center justify-center shrink-0">
                    <span className="text-lg font-black text-white">{initials}</span>
                  </div>
                )}

                {/* Name & provider badge */}
                <div className="flex-1 min-w-0">
                  {fullName && (
                    <p className="text-base font-bold text-[#073b4c] truncate leading-tight">{fullName}</p>
                  )}
                  <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 bg-[#f0f4f8] rounded-full border border-[#073b4c]/10">
                    {provider === 'google' ? (
                      <svg className="size-3" viewBox="0 0 24 24">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                      </svg>
                    ) : (
                      <Mail className="size-3 text-[#118AB2]" />
                    )}
                    <span className="text-[10px] font-semibold text-[#073b4c]/50 capitalize">{provider}</span>
                  </span>
                </div>
              </div>
              {/* ── Plan & Credits ── */}
              <PlanCreditsSection plan={plan} credits={credits} onClose={onClose} />

              {/* Stats Section */}
              <div className="mb-5">
                <h4 className="text-[11px] font-black text-[#073b4c]/30 uppercase tracking-widest mb-3 px-1">My Learning Journey</h4>
                <div className="grid grid-cols-2 gap-2.5 mb-4">
                  <div className="bg-[#ef476f]/5 border-2 border-[#ef476f]/10 rounded-2xl p-3">
                    <p className="text-[10px] font-black text-[#ef476f] uppercase tracking-tighter mb-0.5">Total Points</p>
                    <p className="text-xl font-black text-[#073b4c]">{(stats?.totalScore || 0).toLocaleString()}</p>
                  </div>
                  <div className="bg-[#118ab2]/5 border-2 border-[#118ab2]/10 rounded-2xl p-3">
                    <p className="text-[10px] font-black text-[#118ab2] uppercase tracking-tighter mb-0.5">Global Rank</p>
                    <p className="text-xl font-black text-[#073b4c]">#{stats?.globalRank || '—'}</p>
                  </div>
                  <div className="bg-[#06d6a0]/5 border-2 border-[#06d6a0]/10 rounded-2xl p-3">
                    <p className="text-[10px] font-black text-[#06d6a0] uppercase tracking-tighter mb-0.5">Watch Time</p>
                    <p className="text-xl font-black text-[#073b4c]">
                      {Math.floor((stats?.totalWatchTime || 0) / 60)}<span className="text-[10px]">m</span>
                    </p>
                  </div>
                  <div className="bg-[#ffd166]/10 border-2 border-[#ffd166]/20 rounded-2xl p-3">
                    <p className="text-[10px] font-black text-[#ffd166] uppercase tracking-tighter mb-0.5">Quizzes</p>
                    <p className="text-xl font-black text-[#073b4c]">{stats?.quizzesCompleted || 0}</p>
                  </div>
                </div>

                {/* Mini Leaderboard preview */}
                <LeaderboardCard type="global" limit={3} className="bg-[#f0f4f8]/30 border-[#073b4c]/10 shadow-none rounded-2xl" />
                
                <button 
                  onClick={() => {
                    onClose();
                    window.location.href = '/leaderboard';
                  }}
                  className="w-full mt-3 text-[10px] font-black text-[#118ab2] hover:text-[#073b4c] uppercase tracking-widest transition-colors flex items-center justify-center gap-1.5"
                >
                  View Full Leaderboard →
                </button>
              </div>

              {/* Sign out button */}
              <button
                onClick={handleSignOut}
                className="w-full h-11 rounded-2xl border-[3px] border-[#073b4c] bg-white text-[#073b4c] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#ef476f] hover:text-white hover:translate-y-[-2px] shadow-[3px_3px_0_#073b4c] hover:shadow-[5px_5px_0_#073b4c] transition-all cursor-pointer active:translate-y-0 active:shadow-[2px_2px_0_#073b4c]"
              >
                <LogOut className="size-4" />
                Sign Out
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
