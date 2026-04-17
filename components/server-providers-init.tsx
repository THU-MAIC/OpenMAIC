'use client';

import { useEffect, useRef } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);
  const { status } = useSession();
  const hadFailureRef = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }

    let disposed = false;

    const runFetch = async () => {
      if (disposed) return;
      const ok = await fetchServerProviders();
      if (disposed) return;

      if (!ok) {
        if (!hadFailureRef.current) {
          hadFailureRef.current = true;
          toast.error('Provider sync failed. Retrying in background...');
        }
        return;
      }

      if (hadFailureRef.current) {
        hadFailureRef.current = false;
        toast.success('Provider sync recovered. Server providers are up to date.');
      }
    };

    // Initial fetch + retries to recover from app/server restart windows.
    const bootstrapDelaysMs = [0, 1000, 2500, 5000, 10000, 20000, 30000];
    const bootstrapTimers = bootstrapDelaysMs.map((delay) =>
      window.setTimeout(() => {
        void runFetch();
      }, delay),
    );

    // Keep providers in sync after server restarts without requiring a full reload.
    const periodicTimer = window.setInterval(() => {
      void runFetch();
    }, 60_000);

    const onOnline = () => {
      void runFetch();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void runFetch();
      }
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      bootstrapTimers.forEach((id) => window.clearTimeout(id));
      window.clearInterval(periodicTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchServerProviders, status]);

  return null;
}
