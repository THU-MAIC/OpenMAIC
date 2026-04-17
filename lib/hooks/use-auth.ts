'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/utils/supabase/client';
import type { User, Session } from '@supabase/supabase-js';

export interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

/**
 * Hook to manage Supabase auth state on the client side.
 * Subscribes to auth changes and provides user/session info.
 */
export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
  });

  const getSupabaseCookieNames = () => {
    if (typeof document === 'undefined') return [];
    return document.cookie
      .split(';')
      .map((c) => c.trim().split('=')[0])
      .filter(Boolean)
      .filter((name) => name.startsWith('sb-'))
      .slice(0, 20);
  };

  useEffect(() => {
    const supabase = createClient();

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      // #region agent log
      if (typeof window !== 'undefined') {
        const path = window.location.pathname;
        const cookieNames = getSupabaseCookieNames();
        const hasSbAuthCookie = cookieNames.some((n) => /sb-[^-]+-auth-token/.test(n));
        const hasSessionCookie = cookieNames.some(
          (n) => /sb-[^-]+-auth-token(\.|$)/.test(n) && !n.includes('code-verifier'),
        );
        fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
          body: JSON.stringify({
            sessionId: '9d754c',
            location: 'lib/hooks/use-auth.ts:getSession',
            message: 'Initial getSession resolved',
            data: {
              hypothesisId: 'H4',
              path,
              hasSessionUser: Boolean(session?.user),
              hasSbAuthCookie,
              hasSessionCookie,
              cookieNames,
              runId: 'post-fix-2',
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
      }
      // #endregion
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
      });
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
      });
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setState({ user: null, session: null, loading: false });
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      return data;
    },
    [],
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string) => {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      return data;
    },
    [],
  );

  const signInWithGoogle = useCallback(async (nextPath = '/') => {
    const safe =
      nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/';
    const callback = new URL('/auth/callback', window.location.origin);
    callback.searchParams.set('next', safe);
    // #region agent log
    fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
      body: JSON.stringify({
        sessionId: '9d754c',
        location: 'lib/hooks/use-auth.ts:signInWithGoogle',
        message: 'Starting Google OAuth',
        data: {
          hypothesisId: 'H7',
          redirectTo: callback.toString(),
          nextPath: safe,
          runId: 'post-fix-2',
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callback.toString(),
      },
    });
    if (error) throw error;
    return data;
  }, []);

  return {
    ...state,
    signOut,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
  };
}
