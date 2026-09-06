'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { CodexLoginStart, CodexProviderStatus } from '@/lib/types/codex';
import type { ModelInfo } from '@/lib/types/provider';

interface CodexProviderPanelProps {
  onModelsFetched: (models: ModelInfo[]) => number;
  onConnectionChanged: () => void;
}

interface StatusResponse {
  success: boolean;
  status?: CodexProviderStatus;
  error?: string;
}

interface LoginResponse {
  success: boolean;
  login?: CodexLoginStart;
  error?: string;
}

function formatResetTime(timestamp: number | null, locale: string): string | null {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp * 1000));
}

export function CodexProviderPanel({
  onModelsFetched,
  onConnectionChanged,
}: CodexProviderPanelProps) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<CodexProviderStatus | null>(null);
  const [login, setLogin] = useState<CodexLoginStart | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingLogin, setStartingLogin] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const connectedRef = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/codex', { cache: 'no-store' });
      const data = (await response.json()) as StatusResponse;
      if (!response.ok || !data.success || !data.status) {
        throw new Error(data.error || t('settings.codex.statusFailed'));
      }

      setStatus(data.status);
      setError('');
      if (data.status.models.length > 0) onModelsFetched(data.status.models);

      const connected = data.status.account?.type === 'chatgpt';
      const connectionChanged = connected !== connectedRef.current;
      if (connected) setLogin(null);
      connectedRef.current = connected;
      if (connectionChanged) onConnectionChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.codex.statusFailed'));
    } finally {
      setLoading(false);
    }
  }, [onConnectionChanged, onModelsFetched, t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!login) return;
    const interval = window.setInterval(() => void loadStatus(), 2000);
    return () => window.clearInterval(interval);
  }, [loadStatus, login]);

  const beginLogin = async (mode: 'browser' | 'device') => {
    setStartingLogin(true);
    setError('');
    try {
      const response = await fetch('/api/codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = (await response.json()) as LoginResponse;
      if (!response.ok || !data.success || !data.login) {
        throw new Error(data.error || t('settings.codex.loginFailed'));
      }
      setLogin(data.login);
      if (data.login.type === 'chatgpt') {
        window.open(data.login.authUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.codex.loginFailed'));
    } finally {
      setStartingLogin(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    setError('');
    try {
      const response = await fetch('/api/codex', { method: 'DELETE' });
      const data = (await response.json()) as LoginResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || t('settings.codex.statusFailed'));
      }
      setLogin(null);
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.codex.statusFailed'));
    } finally {
      setSigningOut(false);
    }
  };

  const account = status?.account;
  const connected = account?.type === 'chatgpt';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-medium">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : connected ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-muted-foreground" />
              )}
              {connected
                ? t('settings.codex.connected')
                : status?.enabled === false
                  ? t('settings.codex.disabled')
                  : t('settings.codex.signedOut')}
            </div>
            <p className="text-sm text-muted-foreground">
              {connected
                ? [account.email, account.planType].filter(Boolean).join(' · ')
                : t('settings.codex.description')}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {connected && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void signOut()}
                disabled={signingOut}
              >
                {signingOut && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('settings.codex.signOut')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadStatus()}
              disabled={loading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              {t('settings.codex.refresh')}
            </Button>
          </div>
        </div>

        {status?.enabled && !connected && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void beginLogin('browser')} disabled={startingLogin}>
              {startingLogin && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('settings.codex.signIn')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void beginLogin('device')}
              disabled={startingLogin}
            >
              {t('settings.codex.deviceSignIn')}
            </Button>
          </div>
        )}

        {login?.type === 'chatgpt' && (
          <a
            href={login.authUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            {t('settings.codex.openLogin')}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}

        {login?.type === 'chatgptDeviceCode' && (
          <div className="rounded-md bg-muted p-3 text-sm space-y-2">
            <p>{t('settings.codex.deviceInstructions')}</p>
            <div className="font-mono text-lg font-semibold tracking-wider">{login.userCode}</div>
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              {login.verificationUrl}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}
      </div>

      {connected && status?.rateLimits && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="font-medium">{t('settings.codex.usageTitle')}</div>
          {[status.rateLimits.primary, status.rateLimits.secondary]
            .filter(Boolean)
            .map((window, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span>
                    {i === 0
                      ? t('settings.codex.primaryLimit')
                      : t('settings.codex.secondaryLimit')}
                  </span>
                  <span>{Math.round(window!.usedPercent)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.min(100, Math.max(0, window!.usedPercent))}%` }}
                  />
                </div>
                {formatResetTime(window!.resetsAt, locale) && (
                  <p className="text-xs text-muted-foreground">
                    {t('settings.codex.resetsAt').replace(
                      '{time}',
                      formatResetTime(window!.resetsAt, locale)!,
                    )}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        {t('settings.codex.securityNotice')}
      </div>
    </div>
  );
}
