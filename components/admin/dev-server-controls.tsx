'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';

type ActionKind = 'restart' | 'reset-cache' | null;

export function DevServerControls() {
  const [pending, setPending] = useState<ActionKind>(null);
  const [status, setStatus] = useState<string>('');
  const [awaitingRecovery, setAwaitingRecovery] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);

  useEffect(() => {
    if (!awaitingRecovery) return;

    let active = true;
    const timer = window.setInterval(async () => {
      if (!active) return;
      setRetryAttempt((prev) => prev + 1);
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          setAwaitingRecovery(false);
          setStatus('Dev server is back online.');
          window.setTimeout(() => {
            setStatus('');
            setRetryAttempt(0);
          }, 3000);
        }
      } catch {
        // Keep retrying until server returns.
      }
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [awaitingRecovery]);

  const runAction = async (kind: Exclude<ActionKind, null>) => {
    const confirmed = window.confirm(
      kind === 'restart'
        ? 'Restart the development server now?'
        : 'Clear bundler cache and restart the development server now?',
    );
    if (!confirmed) return;

    setPending(kind);
    setRetryAttempt(0);
    setAwaitingRecovery(true);
    setStatus(
      kind === 'restart'
        ? 'Restarting dev server... waiting for reconnect.'
        : 'Resetting cache and restarting dev server... waiting for reconnect.',
    );

    try {
      const endpoint =
        kind === 'restart'
          ? '/api/admin/devtools/restart'
          : '/api/admin/devtools/reset-cache';

      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // Connection can drop during restart; keep optimistic status.
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => runAction('restart')}
        disabled={pending !== null}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${pending === 'restart' ? 'animate-spin' : ''}`} />
        Restart Dev Server
      </button>

      <button
        type="button"
        onClick={() => runAction('reset-cache')}
        disabled={pending !== null}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors disabled:opacity-50"
      >
        <RotateCcw className={`w-4 h-4 ${pending === 'reset-cache' ? 'animate-spin' : ''}`} />
        Reset Bundler Cache
      </button>

      {status && <p className="px-3 pt-1 text-[11px] text-slate-500 leading-relaxed">{status}</p>}
      {awaitingRecovery && (
        <p className="px-3 text-[11px] text-slate-500 leading-relaxed">
          Retry ping every 2s. Attempt: {retryAttempt}
        </p>
      )}
    </div>
  );
}
