'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CHATGPT_PLAN_API,
  CHATGPT_USAGE_SETTINGS_URL,
  type ChatGPTPlanModel,
  type ChatGPTPlanSignInStart,
  type ChatGPTPlanStatus,
} from '@/lib/chatgpt-plan/shared';
import { useI18n } from '@/lib/hooks/use-i18n';

import type { ProviderFields } from './server-settings';

type Answer<T> = { ok: true; data: T } | { ok: false; reason?: string; error?: string };

async function call<T>(path: string, body?: Record<string, unknown>): Promise<Answer<T>> {
  try {
    const response = await fetch(
      path,
      body === undefined
        ? { cache: 'no-store' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json().catch(() => ({}));
    return response.ok && data.success
      ? { ok: true, data: data as T }
      : {
          ok: false,
          reason: data.reason,
          error: data.errorCode === 'PROVIDER_ACTION_REQUIRED' ? data.error : undefined,
        };
  } catch {
    return { ok: false };
  }
}

export function useChatGPTPlanStatus(offered: boolean) {
  const [status, setStatus] = useState<ChatGPTPlanStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const loadStatus = useCallback(async () => {
    const answer = await call<{ status: ChatGPTPlanStatus }>(CHATGPT_PLAN_API.status);
    const next = answer.ok ? answer.data.status : null;
    setStatus(next);
    setStatusFailed(!answer.ok);
    return next;
  }, []);
  useEffect(() => {
    if (!offered) return;
    void loadStatus();
    window.addEventListener('focus', loadStatus);
    return () => window.removeEventListener('focus', loadStatus);
  }, [offered, loadStatus]);
  return { status, statusFailed, loadStatus };
}

export type PlanAccountState = ReturnType<typeof useChatGPTPlanStatus>;

/** What the settings say for a failure the server reported with a code. */
const REASON_KEYS: Record<string, string> = {
  'sign-in-expired': 'settings.chatgptPlan.errorExpired',
  'sign-in-denied': 'settings.chatgptPlan.errorDenied',
  'invalid-callback': 'settings.chatgptPlan.errorInvalidCallback',
  'sharing-disabled': 'settings.chatgptPlan.sharingDisabled',
  'reauth-required': 'settings.chatgptPlan.reauthRequired',
};

/**
 * The ChatGPT plan provider's account, in place of a key and an endpoint:
 * signing in (in a new tab, or by pasting the address it ends on when the
 * server runs elsewhere), the connected account, and its models.
 */
export function ChatGPTPlanAccount({
  save,
  account: { status, statusFailed, loadStatus },
}: {
  account: PlanAccountState;
  save: (fields: ProviderFields) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<
    (ChatGPTPlanSignInStart & { from: ChatGPTPlanStatus['state'] }) | null
  >(null);
  const [pasting, setPasting] = useState(false);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<'sign-in' | 'paste' | 'models' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const failed = useCallback(
    (answer: { reason?: string; error?: string }) => {
      const key = REASON_KEYS[answer.reason ?? ''];
      setError(key ? t(key) : (answer.error ?? t('settings.chatgptPlan.errorFailed')));
    },
    [t],
  );

  /** Make the provider's model list the account's. */
  const syncModels = useCallback(async () => {
    setError('');
    setBusy('models');
    const answer = await call<{ models: ChatGPTPlanModel[] }>(CHATGPT_PLAN_API.models);
    setBusy(null);
    if (!answer.ok) {
      await loadStatus();
      return failed(answer);
    }
    const { models } = answer.data;
    const windows = Object.fromEntries(
      models.flatMap((model) => (model.contextWindow ? [[model.id, model.contextWindow]] : [])),
    );
    await save({
      models: models.length ? models.map((model) => model.id) : null,
      modelContextWindows: Object.keys(windows).length ? windows : null,
    });
  }, [failed, loadStatus, save]);

  const connected = useCallback(async () => {
    setPending(null);
    setPasting(false);
    setAddress('');
    const next = await loadStatus();
    if (next?.state === 'connected') await syncModels();
  }, [loadStatus, syncModels]);

  // A sign-in in another tab returns to this server: watch for it to land.
  useEffect(() => {
    if (!pending || pending.flow !== 'loopback') return;
    const timer = setInterval(async () => {
      if (Date.now() > pending.expiresAt) return setPending(null);
      const next = await loadStatus();
      if (next && (next.state === 'connected' || next.state !== pending.from)) void connected();
    }, 2000);
    return () => clearInterval(timer);
  }, [pending, loadStatus, connected]);

  const acceptNotice = async () => {
    const answer = await call(CHATGPT_PLAN_API.notice, {});
    if (!answer.ok) return failed(answer);
    await loadStatus();
  };

  const signIn = async () => {
    setError('');
    setBusy('sign-in');
    // Opened within the click, so the browser lets it through; filled in below.
    const tab = window.open('', '_blank');
    const answer = await call<{ signIn: ChatGPTPlanSignInStart }>(CHATGPT_PLAN_API.signIn, {});
    setBusy(null);
    if (!answer.ok) {
      tab?.close();
      return failed(answer);
    }
    const start = answer.data.signIn;
    if (tab) {
      tab.opener = null;
      tab.location.href = start.authorizationUrl;
    }
    setPending({ ...start, from: status?.state ?? 'disconnected' });
    setPasting(start.flow === 'paste');
  };

  const submitAddress = async () => {
    setError('');
    setBusy('paste');
    const answer = await call(CHATGPT_PLAN_API.callback, { address });
    setBusy(null);
    if (!answer.ok) return failed(answer);
    await connected();
  };

  const disconnect = async () => {
    setBusy('disconnect');
    const answer = await call<{ revoked: boolean }>(CHATGPT_PLAN_API.disconnect, {});
    setBusy(null);
    if (!answer.ok) return failed(answer);
    if (!answer.data.revoked) toast.warning(t('settings.chatgptPlan.notRevoked'));
    setPending(null);
    await loadStatus();
  };

  if (!status) {
    return statusFailed || error ? (
      <p className="text-sm text-destructive">{error || t('settings.chatgptPlan.errorFailed')}</p>
    ) : (
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    );
  }
  if (!status.available) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          status.reason === 'disabled'
            ? 'settings.chatgptPlan.unavailableDisabled'
            : 'settings.chatgptPlan.unavailableNotPersonal',
        )}
      </p>
    );
  }

  const usageLink = (
    <Button variant="outline" size="sm" asChild>
      <a href={CHATGPT_USAGE_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
        {t('settings.chatgptPlan.manageUsage')}
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
  const signInButton = (label: string) => (
    <Button size="sm" onClick={signIn} disabled={busy !== null}>
      {busy === 'sign-in' && <Loader2 className="size-3.5 animate-spin" />}
      {label}
    </Button>
  );
  const disconnectButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setConfirmDisconnect(true)}
      disabled={busy !== null}
    >
      {t('settings.chatgptPlan.disconnect')}
    </Button>
  );

  let body: ReactNode;
  if (pending) {
    body = (
      <div className="space-y-3">
        {pending.flow === 'loopback' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            {t('settings.chatgptPlan.waiting')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <a
            href={pending.authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            {t('settings.chatgptPlan.openSignIn')}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
          {!pasting && (
            <button
              type="button"
              className="text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setPasting(true)}
            >
              {t('settings.chatgptPlan.pasteToggle')}
            </button>
          )}
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setPending(null)}
          >
            {t('common.cancel')}
          </button>
        </div>
        {pasting && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (address.trim()) void submitAddress();
            }}
          >
            <p className="text-sm text-muted-foreground">{t('settings.chatgptPlan.pasteHint')}</p>
            <div className="flex gap-2">
              <Input
                name="chatgpt-plan-callback"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://127.0.0.1:…/auth/callback?code=…"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={busy !== null || !address.trim()}>
                {busy === 'paste' && <Loader2 className="size-3.5 animate-spin" />}
                {t('settings.chatgptPlan.pasteSubmit')}
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  } else if (status.state === 'connected') {
    body = (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-green-600" />
          {status.email
            ? t('settings.chatgptPlan.connectedAs', { email: status.email })
            : t('settings.chatgptPlan.connected')}
        </p>
        <div className="flex flex-wrap gap-2">
          {usageLink}
          <Button variant="outline" size="sm" onClick={syncModels} disabled={busy !== null}>
            <RefreshCw className={busy === 'models' ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings.chatgptPlan.refreshModels')}
          </Button>
          {disconnectButton}
        </div>
      </div>
    );
  } else if (status.state === 'sharing-disabled' || status.state === 'reauth-required') {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {t(
            status.state === 'sharing-disabled'
              ? 'settings.chatgptPlan.sharingDisabled'
              : 'settings.chatgptPlan.reauthRequired',
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {signInButton(t('settings.chatgptPlan.signInAgain'))}
          {disconnectButton}
        </div>
      </div>
    );
  } else if (!status.noticeAcknowledged) {
    body = (
      <div className="space-y-3">
        <p className="text-sm font-medium">{t('settings.chatgptPlan.noticeTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('settings.chatgptPlan.noticeBody')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={acceptNotice}>
            {t('settings.chatgptPlan.noticeAccept')}
          </Button>
          {usageLink}
        </div>
      </div>
    );
  } else {
    body = signInButton(t('settings.chatgptPlan.signIn'));
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {body}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.chatgptPlan.disconnect')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.chatgptPlan.disconnectConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void disconnect()}>
              {t('settings.chatgptPlan.disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
