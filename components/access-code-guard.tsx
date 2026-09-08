'use client';

import { useEffect, useState, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AccessCodeModal } from '@/components/access-code-modal';
import { useSettingsStore } from '@/lib/store/settings';

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<{
    enabled: boolean;
    authenticated: boolean;
    loading: boolean;
  }>({ enabled: false, authenticated: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    // Never trust the previous path's answer while switching routes.
    /* eslint-disable react-hooks/set-state-in-effect -- a route change must clear the previous path's answer */
    setStatus((s) => (s.loading ? s : { ...s, loading: true }));
    /* eslint-enable react-hooks/set-state-in-effect */
    // The path lets the server skip the modal for SSO-authenticated
    // courseware viewers (teachers/students) and role-0 admins.
    fetch(`/api/access-code/status?path=${encodeURIComponent(pathname ?? '')}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setStatus({
            enabled: data.enabled,
            authenticated: data.authenticated,
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Default to requiring auth on error — safer than silently disabling
          setStatus({ enabled: true, authenticated: false, loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Login and forbidden pages are public: the password modal must never block
  // the SSO login flow.
  const isAuthPage = pathname === '/login' || pathname === '/forbidden';
  const needsAuth = !status.loading && status.enabled && !status.authenticated && !isAuthPage;

  return (
    <>
      {needsAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => {
            setStatus((s) => ({ ...s, authenticated: true }));
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
