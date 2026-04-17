'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import type { AuthError } from '@supabase/supabase-js';

function sanitizeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return '/';
  }
  return next;
}

/** Dedupe PKCE exchange when React Strict Mode runs the effect twice in dev. */
let pkceExchangePromise: Promise<{ error: AuthError | null }> | null = null;
let pkceExchangeCode: string | null = null;

function getOrStartExchange(code: string) {
  if (pkceExchangeCode === code && pkceExchangePromise) {
    return pkceExchangePromise;
  }
  pkceExchangeCode = code;
  const supabase = createClient();
  pkceExchangePromise = supabase.auth.exchangeCodeForSession(code).then(({ error }) => ({
    error,
  }));
  return pkceExchangePromise;
}

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message] = useState('Signing you in…');

  useEffect(() => {
    const code = searchParams.get('code');
    const next = sanitizeNext(searchParams.get('next'));

    if (!code) {
      router.replace('/auth/login?error=auth_failed');
      return;
    }

    const p = getOrStartExchange(code);
    void p.then(({ error }) => {
      // #region agent log
      fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
        body: JSON.stringify({
          sessionId: '9d754c',
          location: 'app/auth/callback/page.tsx:exchangeResult',
          message: 'Client exchangeCodeForSession finished',
          data: {
            hypothesisId: 'H6',
            ok: !error,
            errMessage: error?.message ?? null,
            runId: 'post-fix-2',
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      pkceExchangePromise = null;
      pkceExchangeCode = null;

      if (error) {
        router.replace('/auth/login?error=auth_failed');
        return;
      }
      router.replace(next);
    });
  }, [router, searchParams]);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="flex flex-col items-center gap-3">
        <div className="size-10 rounded-full border-4 border-[#073b4c] border-t-transparent animate-spin" />
        <p className="text-sm font-medium text-[#073b4c]/70">{message}</p>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100">
          <div className="size-10 rounded-full border-4 border-[#073b4c] border-t-transparent animate-spin" />
        </div>
      }
    >
      <AuthCallbackInner />
    </Suspense>
  );
}
