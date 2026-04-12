'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ArrowRight, ShieldCheck, LoaderCircle } from 'lucide-react';

interface AccessCodeModalProps {
  open: boolean;
  onSuccess: () => void;
}

export function AccessCodeModal({ open, onSuccess }: AccessCodeModalProps) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code || loading) return;
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/access-code/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (res.ok) {
        setSuccess(true);
        setTimeout(onSuccess, 600);
      } else {
        setError(t('accessCode.error'));
        setCode('');
        inputRef.current?.focus();
      }
    } catch {
      setError(t('accessCode.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
        >
          {/* Background — subtle mesh gradient */}
          <div className="absolute inset-0 bg-background">
            <div
              className="absolute inset-0 opacity-30 dark:opacity-20"
              style={{
                backgroundImage: `
                  radial-gradient(ellipse 80% 60% at 20% 40%, var(--primary) 0%, transparent 60%),
                  radial-gradient(ellipse 60% 80% at 80% 20%, oklch(0.6 0.15 280) 0%, transparent 50%),
                  radial-gradient(ellipse 50% 50% at 60% 80%, oklch(0.5 0.12 300) 0%, transparent 50%)
                `,
              }}
            />
            {/* Subtle noise texture */}
            <div
              className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
                backgroundSize: '128px 128px',
              }}
            />
          </div>

          {/* Content card */}
          <motion.div
            className="relative z-10 w-full max-w-sm mx-4"
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.96 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="rounded-2xl border border-border/50 bg-card/80 p-8 shadow-xl shadow-black/5 backdrop-blur-xl dark:bg-card/60 dark:shadow-black/20">
              {/* Icon */}
              <motion.div
                className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.15, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              >
                <ShieldCheck className="h-7 w-7 text-primary" strokeWidth={1.5} />
              </motion.div>

              {/* Title */}
              <motion.h1
                className="mb-1 text-center text-lg font-semibold tracking-tight text-foreground"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                {t('accessCode.title')}
              </motion.h1>

              <motion.p
                className="mb-6 text-center text-sm text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.25, duration: 0.4 }}
              >
                OpenMAIC
              </motion.p>

              {/* Form */}
              <motion.form
                onSubmit={handleSubmit}
                className="space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.4 }}
              >
                <div className="relative">
                  <input
                    ref={inputRef}
                    type="password"
                    placeholder={t('accessCode.placeholder')}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      if (error) setError('');
                    }}
                    className={`
                      w-full rounded-xl border bg-background/60 px-4 py-3 pr-12 text-sm
                      outline-none transition-all duration-200
                      placeholder:text-muted-foreground/50
                      focus:border-primary/40 focus:ring-2 focus:ring-primary/10
                      ${error ? 'border-destructive/50 focus:border-destructive/50 focus:ring-destructive/10' : 'border-border/60'}
                    `}
                    disabled={loading || success}
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    disabled={!code || loading || success}
                    className={`
                      absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center
                      justify-center rounded-lg transition-all duration-200
                      ${code && !loading && !success ? 'bg-primary text-primary-foreground hover:opacity-90 cursor-pointer' : 'text-muted-foreground/30 cursor-default'}
                    `}
                  >
                    {loading ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : success ? (
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                      >
                        <ShieldCheck className="h-4 w-4 text-emerald-500" />
                      </motion.div>
                    ) : (
                      <ArrowRight className="h-4 w-4" />
                    )}
                  </button>
                </div>

                {/* Error message */}
                <AnimatePresence mode="wait">
                  {error && (
                    <motion.p
                      className="text-center text-sm text-destructive"
                      initial={{ opacity: 0, y: -4, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                      exit={{ opacity: 0, y: -4, height: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.form>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
