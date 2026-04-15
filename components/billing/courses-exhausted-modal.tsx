'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Zap, Plus, Crown, AlertTriangle, BarChart3 } from 'lucide-react';
import { toast } from 'sonner';

interface CoursesExhaustedModalProps {
  open: boolean;
  onClose: () => void;
  /** 'free_limit_reached' | 'monthly_limit_reached' */
  reason?: string;
}

export function CoursesExhaustedModal({ open, onClose, reason }: CoursesExhaustedModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState<'topup' | 'upgrade' | null>(null);
  const isFreeLimit = reason === 'free_limit_reached';

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleTopup = async () => {
    setLoading('topup');
    try {
      const res = await fetch('/api/stripe/topup', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to start checkout');
      if (json.url) window.location.href = json.url;
    } catch (err: any) {
      toast.error(err.message || 'Something went wrong');
    } finally {
      setLoading(null);
    }
  };

  const handleUpgrade = () => {
    onClose();
    window.location.href = '/pricing';
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm"
            ref={overlayRef}
            onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
            aria-hidden
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 24 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[201]
              w-[92vw] max-w-[420px] rounded-3xl border-[3px] border-[#ef476f]
              bg-white shadow-[6px_6px_0_#ef476f] overflow-hidden"
            role="dialog"
            aria-modal="true"
          >
            {/* Top accent */}
            <div className="h-2 w-full bg-gradient-to-r from-[#ef476f] via-[#ffd166] to-[#ef476f]" />

            {/* Close */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 size-7 rounded-full border-2 border-[#073b4c]/20
                flex items-center justify-center hover:bg-[#f0f4f8] hover:border-[#073b4c]/40
                transition-all cursor-pointer z-10"
            >
              <X className="size-3.5 text-[#073b4c]/60" />
            </button>

            <div className="px-7 pt-6 pb-7">
              {/* Icon + Title */}
              <div className="flex items-center gap-3 mb-4">
                <div className="size-12 rounded-2xl bg-[#ef476f]/10 border-[3px] border-[#ef476f]/20
                  flex items-center justify-center shrink-0">
                  <AlertTriangle className="size-6 text-[#ef476f]" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-[#ef476f] mb-0.5">
                    Courses Exhausted
                  </p>
                  <h2 className="text-xl font-black text-[#073b4c] leading-tight">
                    {isFreeLimit ? "Free credits used up" : "Monthly limit reached"}
                  </h2>
                </div>
              </div>

              <p className="text-sm text-[#073b4c]/60 mb-5 leading-relaxed">
                {isFreeLimit
                  ? "You've used both of your free course credits. Top up 10 courses for $5, or upgrade to Plus for 30 courses per month."
                  : "You've hit your 30-course monthly limit. Top up 10 extra courses for $5, or wait for your next billing cycle."}
              </p>

              {/* Stats mini-card */}
              <div className="flex items-center gap-2 bg-[#f0f4f8] rounded-2xl border-2 border-[#073b4c]/10 px-3 py-2.5 mb-5">
                <BarChart3 className="size-4 text-[#073b4c]/40 shrink-0" />
                <span className="text-xs font-bold text-[#073b4c]/60">
                  {isFreeLimit
                    ? '2 of 2 lifetime credits used'
                    : '30 of 30 monthly courses used'}
                </span>
                <span className="ml-auto text-xs font-black text-[#ef476f]">0 remaining</span>
              </div>

              {/* Primary CTA — Top Up */}
              <button
                onClick={handleTopup}
                disabled={!!loading}
                className="w-full h-12 rounded-2xl border-[3px] border-[#073b4c] bg-[#073b4c]
                  text-white font-black text-sm flex items-center justify-center gap-2
                  hover:bg-[#118AB2] hover:border-[#118AB2] hover:shadow-[5px_5px_0_#073b4c]
                  shadow-[3px_3px_0_#073b4c] transition-all cursor-pointer
                  disabled:opacity-50 hover:-translate-y-0.5 active:translate-y-0
                  active:shadow-[2px_2px_0_#073b4c] mb-3"
              >
                {loading === 'topup' ? (
                  'Redirecting…'
                ) : (
                  <>
                    <Plus className="size-4" />
                    Top Up 10 Courses — $5
                  </>
                )}
              </button>

              {/* Secondary CTA — Upgrade to Plus (for free users) */}
              {isFreeLimit && (
                <button
                  onClick={handleUpgrade}
                  disabled={!!loading}
                  className="w-full h-11 rounded-2xl border-[3px] border-[#118AB2]
                    text-[#118AB2] font-bold text-sm flex items-center justify-center gap-2
                    hover:bg-[#118AB2]/5 transition-colors cursor-pointer disabled:opacity-50 mb-3"
                >
                  <Zap className="size-4" />
                  Upgrade to Plus — 30/month
                </button>
              )}

              {/* Or view pricing */}
              <button
                onClick={() => { onClose(); window.location.href = '/pricing'; }}
                className="w-full text-center text-xs font-semibold text-[#073b4c]/40
                  hover:text-[#073b4c]/70 transition-colors cursor-pointer flex items-center
                  justify-center gap-1.5"
              >
                <Crown className="size-3" />
                View all plans
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
