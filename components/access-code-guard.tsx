'use client';

import { useEffect, useState, ReactNode } from 'react';
import { AccessCodeModal } from '@/components/access-code-modal';
import { useSettingsStore } from '@/lib/store/settings';

type AccessStatus = {
  enabled: boolean;
  authenticated: boolean;
  loading: boolean;
};

const ACCESS_STATUS_CACHE_KEY = 'openmaic:last-access-status';

function readCachedAccessStatus(): AccessStatus | null {
  try {
    const cached = window.localStorage.getItem(ACCESS_STATUS_CACHE_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as Partial<AccessStatus>;
    if (typeof parsed.enabled !== 'boolean' || typeof parsed.authenticated !== 'boolean') {
      return null;
    }
    return { enabled: parsed.enabled, authenticated: parsed.authenticated, loading: false };
  } catch {
    return null;
  }
}

function cacheAccessStatus(status: Omit<AccessStatus, 'loading'>) {
  try {
    window.localStorage.setItem(ACCESS_STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    // Storage can be unavailable in private browsing; the in-memory state still works.
  }
}

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccessStatus>({
    enabled: false,
    authenticated: false,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    if (!navigator.onLine) {
      const cached = readCachedAccessStatus();
      queueMicrotask(() => {
        if (!cancelled) {
          setStatus(cached ?? { enabled: true, authenticated: false, loading: false });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    fetch('/api/access-code/status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          const nextStatus = {
            enabled: data.enabled,
            authenticated: data.authenticated,
            loading: false,
          } satisfies AccessStatus;
          cacheAccessStatus(nextStatus);
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // A cached result was verified by this same origin during an earlier online visit.
          // If none exists, keep the original fail-closed behavior.
          setStatus(
            readCachedAccessStatus() ?? {
              enabled: true,
              authenticated: false,
              loading: false,
            },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsAuth = !status.loading && status.enabled && !status.authenticated;

  return (
    <>
      {needsAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => {
            setStatus((current) => {
              const nextStatus = { ...current, authenticated: true };
              cacheAccessStatus(nextStatus);
              return nextStatus;
            });
            // ServerProvidersInit runs on mount, which on an ACCESS_CODE-gated
            // deployment is before any access cookie exists: the middleware
            // answers 401 and the store silently keeps its blank defaults.
            // Nothing re-fetches afterwards, so every server-configured
            // provider reads as unconfigured until a manual reload. Re-fetch
            // now that the request will be authorized.
            void useSettingsStore.getState().fetchServerProviders();
          }}
        />
      )}
      {children}
    </>
  );
}
