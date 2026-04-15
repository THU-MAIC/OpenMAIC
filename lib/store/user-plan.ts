/**
 * User Plan Store
 *
 * Global, reactive store for the current user's billing plan and course credits.
 * Components that display credit usage (profile modal, generation UI) subscribe
 * to this store so they always reflect the latest state without prop-drilling.
 *
 * Call `usePlanStore.getState().refetch()` after any operation that modifies
 * credits (e.g. after a course is successfully saved).
 */

import { create } from 'zustand';
import type { UserPlan } from '@/lib/stripe/plans';

interface CreditSummary {
  used: number;
  total: number | 'unlimited';
  remaining: number | 'unlimited';
  resetsAt: string | null;
}

interface PlanState {
  plan: UserPlan | null;
  credits: CreditSummary | null;
  isLoading: boolean;
  /** Incremented every time the store successfully refreshes */
  version: number;
  /** Fetch /api/user/plan and update state */
  refetch: () => Promise<void>;
  /** Clear state (on sign-out) */
  clear: () => void;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  plan: null,
  credits: null,
  isLoading: false,
  version: 0,

  refetch: async () => {
    if (get().isLoading) return;
    set({ isLoading: true });
    try {
      const res = await fetch('/api/user/plan');
      if (!res.ok) throw new Error('Failed to fetch plan');
      const json = await res.json();
      if (json.success) {
        set((s) => ({
          plan: json.plan,
          credits: json.credits,
          isLoading: false,
          version: s.version + 1,
        }));
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  clear: () => set({ plan: null, credits: null, isLoading: false }),
}));
