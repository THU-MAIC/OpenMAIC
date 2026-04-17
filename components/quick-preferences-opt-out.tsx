'use client';

import { useEffect } from 'react';

declare global {
  interface Window {
    __quickPreferencesOptOutCount?: number;
  }
}

const OPT_OUT_EVENT = 'quick-preferences-opt-out-change';

function emitOptOutChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OPT_OUT_EVENT));
}

export function QuickPreferencesOptOut({ active = true }: { active?: boolean }) {
  useEffect(() => {
    if (!active || typeof window === 'undefined' || typeof document === 'undefined') return;

    window.__quickPreferencesOptOutCount = (window.__quickPreferencesOptOutCount ?? 0) + 1;
    document.body.dataset.quickPreferencesOptOut = '1';
    emitOptOutChange();

    return () => {
      const next = Math.max(0, (window.__quickPreferencesOptOutCount ?? 1) - 1);
      window.__quickPreferencesOptOutCount = next;
      if (next === 0) {
        delete document.body.dataset.quickPreferencesOptOut;
      }
      emitOptOutChange();
    };
  }, [active]);

  return null;
}

export const QUICK_PREFERENCES_OPT_OUT_EVENT = OPT_OUT_EVENT;
