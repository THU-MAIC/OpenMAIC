'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { Mail, Lock, ArrowRight, Eye, EyeOff, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/hooks/use-auth';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, signInWithEmail, signUpWithEmail, signInWithGoogle } = useAuth();

  // If user has a pending redirect (from "Enter Classroom" flow)
  const redirectTo = searchParams.get('redirect') || '/';
  const errorParam = searchParams.get('error');

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(errorParam === 'auth_failed' ? 'Authentication failed. Please try again.' : null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    if (!loading && user) {
      router.replace(redirectTo);
    }
  }, [user, loading, router, redirectTo]);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      if (mode === 'login') {
        await signInWithEmail(email, password);
        router.replace(redirectTo);
      } else {
        await signUpWithEmail(email, password);
        setSuccess('Check your email for a confirmation link!');
        setEmail('');
        setPassword('');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError(null);
    try {
      await signInWithGoogle(redirectTo);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed';
      setError(message);
    }
  };

  if (loading) {
    return (
      <div className="h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 flex items-center justify-center">
        <div className="size-10 rounded-full border-4 border-[#073b4c] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (user) return null; // Will redirect via useEffect

  return (
    <div className="h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 flex flex-col items-center justify-center overflow-hidden relative">
      {/* Floating shapes matching brand */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="floating-shape absolute top-[8%] left-[6%] w-14 h-14 bg-[#FFD166] rounded-full border-4 border-[#073B4C] opacity-40" style={{ animationDelay: '0s' }} />
        <div className="floating-shape-reverse absolute top-[12%] right-[10%] w-12 h-12 bg-[#EF476F] rounded-2xl border-4 border-[#073B4C] opacity-40" style={{ animationDelay: '1s' }} />
        <div className="floating-shape absolute bottom-[15%] left-[10%] w-18 h-18 bg-[#118AB2] rounded-full border-4 border-[#073B4C] opacity-25" style={{ animationDelay: '2s' }} />
        <div className="floating-shape-reverse absolute bottom-[25%] right-[8%] w-10 h-10 bg-[#06D6A0] rounded-3xl border-4 border-[#073B4C] opacity-35" style={{ animationDelay: '0.5s' }} />
        <div className="floating-shape absolute top-[50%] left-[50%] w-8 h-8 bg-[#8338EC] rounded-full border-4 border-[#073B4C] opacity-20" style={{ animationDelay: '1.5s' }} />
      </div>

      {/* Login card */}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative z-20 w-full max-w-[420px] mx-4"
      >
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 20 }}
          className="flex items-center justify-center gap-2.5 mb-8"
        >
          <h1 className="text-5xl font-black text-[#073b4c] tracking-tighter">SLATE UP</h1>
          {/* <span className="px-2.5 py-0.5 bg-[#ef476f] text-white text-[10px] font-bold rounded-full border-2 border-[#073b4c] shadow-[2px_2px_0_#073b4c] uppercase tracking-widest mt-1">BETA</span> */}
        </motion.div>

        {/* Card */}
        <div className="rounded-3xl border-[3px] border-[#073b4c] bg-white shadow-[8px_8px_0_#073b4c] p-6 md:p-8">
          {/* Tab switcher */}
          <div className="flex gap-1 p-1 bg-[#f0f4f8] rounded-2xl mb-6 border-2 border-[#073b4c]/10">
            <button
              onClick={() => { setMode('login'); setError(null); setSuccess(null); }}
              className={`flex-1 py-2.5 text-sm font-bold rounded-xl transition-all duration-200 ${
                mode === 'login'
                  ? 'bg-white text-[#073b4c] shadow-[3px_3px_0_#073b4c] border-2 border-[#073b4c] translate-y-[-1px]'
                  : 'text-[#073b4c]/50 hover:text-[#073b4c]/70'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => { setMode('signup'); setError(null); setSuccess(null); }}
              className={`flex-1 py-2.5 text-sm font-bold rounded-xl transition-all duration-200 ${
                mode === 'signup'
                  ? 'bg-white text-[#073b4c] shadow-[3px_3px_0_#073b4c] border-2 border-[#073b4c] translate-y-[-1px]'
                  : 'text-[#073b4c]/50 hover:text-[#073b4c]/70'
              }`}
            >
              Sign Up
            </button>
          </div>

          {/* Error / Success messages */}
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 p-3 bg-[#ef476f]/10 border-2 border-[#ef476f]/30 rounded-xl flex items-center gap-2"
              >
                <AlertCircle className="size-4 text-[#ef476f] shrink-0" />
                <p className="text-xs font-medium text-[#ef476f]">{error}</p>
              </motion.div>
            )}
            {success && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 p-3 bg-[#06D6A0]/10 border-2 border-[#06D6A0]/30 rounded-xl flex items-center gap-2"
              >
                <CheckCircle2 className="size-4 text-[#06D6A0] shrink-0" />
                <p className="text-xs font-medium text-[#06D6A0]">{success}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Google sign-in button */}
          <button
            onClick={handleGoogleAuth}
            className="w-full flex items-center justify-center gap-3 h-12 rounded-2xl border-[3px] border-[#073b4c] bg-white text-[#073b4c] font-bold text-sm hover:translate-y-[-2px] shadow-[4px_4px_0_#073b4c] hover:shadow-[6px_6px_0_#073b4c] transition-all cursor-pointer active:translate-y-0 active:shadow-[2px_2px_0_#073b4c]"
          >
            <svg className="size-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-[2px] bg-[#073b4c]/10 rounded-full" />
            <span className="text-[11px] font-bold text-[#073b4c]/30 uppercase tracking-wider">or</span>
            <div className="flex-1 h-[2px] bg-[#073b4c]/10 rounded-full" />
          </div>

          {/* Email/Password form */}
          <form onSubmit={handleEmailAuth} className="space-y-3">
            <div className="relative">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-[#073b4c]/40" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                required
                className="w-full h-12 pl-11 pr-4 rounded-2xl border-[3px] border-[#073b4c]/20 bg-[#f0f4f8]/50 text-sm font-medium text-[#073b4c] placeholder:text-[#073b4c]/35 focus:border-[#118AB2] focus:outline-none transition-colors"
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-[#073b4c]/40" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                minLength={6}
                className="w-full h-12 pl-11 pr-12 rounded-2xl border-[3px] border-[#073b4c]/20 bg-[#f0f4f8]/50 text-sm font-medium text-[#073b4c] placeholder:text-[#073b4c]/35 focus:border-[#118AB2] focus:outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-[#073b4c]/30 hover:text-[#073b4c]/60 transition-colors"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className={`w-full h-12 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 border-[3px] border-[#073b4c] transition-all cursor-pointer ${
                submitting
                  ? 'bg-[#f0f4f8] text-[#073b4c]/40 cursor-not-allowed'
                  : 'bg-[#ef476f] text-white hover:translate-y-[-2px] shadow-[4px_4px_0_#073b4c] hover:shadow-[6px_6px_0_#073b4c] active:translate-y-0 active:shadow-[2px_2px_0_#073b4c]'
              }`}
            >
              {submitting ? (
                <div className="size-5 rounded-full border-2 border-[#073b4c]/20 border-t-[#073b4c] animate-spin" />
              ) : (
                <>
                  {mode === 'login' ? 'Sign In' : 'Create Account'}
                  <ArrowRight className="size-4" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Back to home */}
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          onClick={() => router.push('/')}
          className="mt-6 mx-auto flex items-center gap-2 text-sm font-semibold text-[#073b4c]/50 hover:text-[#073b4c] transition-colors cursor-pointer"
        >
          ← Back to home
        </motion.button>
      </motion.div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 flex items-center justify-center">
        <div className="size-10 rounded-full border-4 border-[#073b4c] border-t-transparent animate-spin" />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
