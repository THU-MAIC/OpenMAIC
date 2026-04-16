'use client';

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, LogOut, Mail, Zap, Crown, Shield, BookOpen, ExternalLink, RefreshCw, Flame, GraduationCap } from 'lucide-react';
import { useAuth } from '@/lib/hooks/use-auth';
import { usePlanStore } from '@/lib/store/user-plan';
import type { UserPlan } from '@/lib/stripe/plans';

type ProfileCertificate = { id: string; courseId: string; courseName: string; createdAt: string };

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
  isLoading,
  onRefresh,
  onClose,
}: {
  plan: UserPlan | null;
  credits: { used: number; total: number | 'unlimited'; remaining: number | 'unlimited'; resetsAt: string | null } | null;
  isLoading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  if (!plan && isLoading) {
    return <div className="mb-4 h-20 rounded-2xl bg-[#f0f4f8] animate-pulse" />;
  }

  if (!plan) return null;

  const meta   = ACCOUNT_META[plan.account_type] ?? ACCOUNT_META.FREE;
  const isPaid = plan.account_type === 'PLUS' || plan.account_type === 'ADMIN';

  const used      = credits?.used      ?? 0;
  const total     = credits?.total     ?? (plan.account_type === 'FREE' ? 2 : 30);
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
      <div className="flex items-center justify-between mb-2 px-1">
        <h4 className="text-[11px] font-black text-[#073b4c]/30 uppercase tracking-widest">Plan & Credits</h4>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh plan data"
          className="size-5 flex items-center justify-center rounded-full hover:bg-[#f0f4f8]
            text-[#073b4c]/30 hover:text-[#073b4c]/60 transition-all disabled:opacity-40 cursor-pointer"
        >
          <RefreshCw className={`size-3 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

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
            className="flex items-center gap-1 text-[10px] font-black text-[#118AB2] hover:text-[#073b4c] transition-colors cursor-pointer"
          >
            <Crown className="size-3" /> Upgrade
          </button>
        )}
        {isPaid && plan.subscription_period !== 'lifetime' && (
          <button
            onClick={handleManageBilling}
            className="flex items-center gap-1 text-[10px] font-semibold text-[#073b4c]/40 hover:text-[#073b4c] transition-colors cursor-pointer"
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

        {plan.extra_credits > 0 && (
          <div className="flex items-center gap-1.5 mb-2 px-1">
            <div className="size-1.5 rounded-full bg-[#118AB2] animate-pulse" />
            <span className="text-[9px] font-bold text-[#118AB2]">
              Includes {plan.extra_credits} top-up credits
            </span>
          </div>
        )}

        {total !== 'unlimited' ? (
          <>
            <div className="w-full h-1.5 rounded-full bg-[#073b4c]/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
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
            className="mt-2 w-full h-7 rounded-xl bg-[#073b4c] text-white text-[10px] font-black hover:bg-[#118AB2] transition-colors cursor-pointer"
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
  const portalReady = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [stats, setStats] = useState<{
    totalScore?: number;
    globalRank?: number;
    currentStreak?: number;
    highestStreak?: number;
    totalWatchTime?: number;
    coursesCompleted?: number;
    certificates?: ProfileCertificate[];
  } | null>(null);
  const [certificatesOpen, setCertificatesOpen] = useState(false);

  const closeProfile = useCallback(() => {
    setCertificatesOpen(false);
    onClose();
  }, [onClose]);

  // Plan data comes from the global store — always up-to-date across the app
  const { plan, credits, isLoading: planLoading, refetch: refetchPlan } = usePlanStore();

  useEffect(() => {
    if (open && user) {
      // Always refresh plan data when the modal opens
      refetchPlan();

      fetch('/api/analytics/user-stats')
        .then(res => res.json())
        .then(json => { if (json.success) setStats(json.stats); })
        .catch(err => console.error('Failed to fetch stats:', err));
    }
  }, [open, user, refetchPlan]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeProfile();
      }
    };
    // Delay listener so the opening click doesn't immediately close
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [open, closeProfile]);

  // Close on Escape (certificates sheet first, then profile)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (certificatesOpen) {
        setCertificatesOpen(false);
        return;
      }
      closeProfile();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, closeProfile, certificatesOpen]);

  const handleSignOut = async () => {
    await signOut();
    closeProfile();
    window.location.href = '/';
  };

  if (!user) return null;

  // Extract user info
  const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture;
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name || '';
  const email = user.email || '';
  const provider = user.app_metadata?.provider || 'email';
  const initials = fullName
    ? fullName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : email.slice(0, 2).toUpperCase();

  const overlay = (
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
            className="fixed top-16 right-4 z-[100] flex min-h-0 w-[320px] max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-3xl border-[3px] border-[#073b4c] bg-white shadow-[6px_6px_0_#073b4c]"
          >
            {/* Certificates overlay */}
            {certificatesOpen && (
              <div className="absolute inset-0 z-20 flex flex-col bg-white rounded-[20px]">
                <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b-2 border-[#073b4c]/10 shrink-0">
                  <h3 className="text-xs font-black text-[#073b4c] tracking-tight flex items-center gap-1.5">
                    <GraduationCap className="size-3.5 text-[#06d6a0]" />
                    Your certificates
                  </h3>
                  <button
                    type="button"
                    onClick={() => setCertificatesOpen(false)}
                    className="size-7 rounded-full border-2 border-[#073b4c]/20 flex items-center justify-center hover:bg-[#f0f4f8] hover:border-[#073b4c]/40 transition-all cursor-pointer"
                    aria-label="Back to profile"
                  >
                    <X className="size-3.5 text-[#073b4c]/60" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
                  {!(stats?.certificates?.length) ? (
                    <p className="text-[11px] font-semibold text-[#073b4c]/45 leading-relaxed">
                      Complete a course to earn your first certificate. It will show up here.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {stats.certificates.map((c) => (
                        <li key={c.id}>
                          <a
                            href={`/c/${c.id}`}
                            className="flex items-start gap-2.5 rounded-xl border-2 border-[#073b4c]/10 bg-[#f0f4f8]/60 px-3 py-2.5 hover:border-[#06d6a0]/40 hover:bg-[#06d6a0]/5 transition-all group cursor-pointer"
                          >
                            <GraduationCap className="size-4 text-[#06d6a0] shrink-0 mt-0.5" />
                            <span className="flex-1 min-w-0">
                              <span className="block text-xs font-black text-[#073b4c] group-hover:text-[#118AB2] leading-snug">
                                {c.courseName}
                              </span>
                              <span className="text-[9px] font-bold text-[#073b4c]/35 uppercase tracking-tight">
                                {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}
                              </span>
                            </span>
                            <ExternalLink className="size-3.5 text-[#073b4c]/25 group-hover:text-[#118AB2] shrink-0 mt-0.5" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {/* Header */}
            <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
              <h3 className="text-sm font-black text-[#073b4c] tracking-tight">Your Profile</h3>
              <button
                onClick={closeProfile}
                className="size-7 rounded-full border-2 border-[#073b4c]/20 flex items-center justify-center hover:bg-[#f0f4f8] hover:border-[#073b4c]/40 transition-all cursor-pointer"
              >
                <X className="size-3.5 text-[#073b4c]/60" />
              </button>
            </div>

            {/* User info — scrolls when content exceeds viewport */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
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
              <PlanCreditsSection
                plan={plan}
                credits={credits}
                isLoading={planLoading}
                onRefresh={refetchPlan}
                onClose={closeProfile}
              />

              {/* Stats Section */}
              <div className="mb-5">
                <h4 className="text-[11px] font-black text-[#073b4c]/30 uppercase tracking-widest mb-3 px-1">My Learning Journey</h4>
                <div className="grid grid-cols-2 gap-2.5 mb-4">
                  <div className="col-span-1 bg-[#ef476f]/5 border-2 border-[#ef476f]/10 rounded-2xl p-3 flex flex-col justify-center">
                    <p className="text-[10px] font-black text-[#ef476f] uppercase tracking-tighter mb-0.5">Total Points</p>
                    <p className="text-xl/none font-black text-[#073b4c]">{(stats?.totalScore || 0).toLocaleString()}</p>
                  </div>
                  <div className="col-span-1 bg-[#118ab2]/5 border-2 border-[#118ab2]/10 rounded-2xl p-3 flex flex-col justify-center">
                    <p className="text-[10px] font-black text-[#118ab2] uppercase tracking-tighter mb-0.5">Global Rank</p>
                    <p className="text-xl/none font-black text-[#073b4c]">
                      #{stats?.globalRank?.toLocaleString() || '-'}
                    </p>
                  </div>
                  <div className="col-span-2 bg-[#ff9f1c]/10 border-2 border-[#ff9f1c]/20 rounded-2xl p-3 flex items-center justify-between">
                    <div>
                      <p className="text-[10px] font-black text-[#ff9f1c] uppercase tracking-tighter mb-0.5 flex items-center gap-1"><Flame className="size-3" /> Current Streak</p>
                      <p className="text-xl/none font-black text-[#073b4c]">{stats?.currentStreak || 0} <span className="text-[12px] opacity-60">Days</span></p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-black text-[#ff9f1c]/60 uppercase tracking-tighter mb-0.5">Best</p>
                      <p className="text-sm/none font-black text-[#073b4c]/60">{stats?.highestStreak || 0} Days</p>
                    </div>
                  </div>
                  <div className="bg-[#06d6a0]/5 border-2 border-[#06d6a0]/10 rounded-2xl p-3">
                    <p className="text-[10px] font-black text-[#06d6a0] uppercase tracking-tighter mb-0.5">Watch Time</p>
                    <p className="text-xl/none font-black text-[#073b4c]">
                      {Math.floor((stats?.totalWatchTime || 0) / 60)}<span className="text-[10px]">m</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCertificatesOpen(true)}
                    className="text-left bg-violet-500/8 border-2 border-violet-500/20 rounded-2xl p-3 hover:border-violet-500/40 hover:bg-violet-500/12 transition-all cursor-pointer w-full"
                  >
                    <p className="text-[10px] font-black text-violet-700 uppercase tracking-tighter mb-0.5 flex items-center gap-1">
                      <GraduationCap className="size-3" />
                      Courses completed
                    </p>
                    <p className="text-xl/none font-black text-[#073b4c]">{stats?.coursesCompleted ?? 0}</p>
                    <p className="text-[9px] font-bold text-[#073b4c]/35 mt-0.5">Tap to view certificates</p>
                  </button>
                </div>
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

  if (!portalReady) return null;

  return createPortal(overlay, document.body);
}
