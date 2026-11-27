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
  type ChatGPTPlanAttemptOutcome,
} from '@/lib/chatgpt-plan/shared';
import { useI18n } from '@/lib/hooks/use-i18n';

import type { ProviderFields } from './server-settings';

import { callChatGPTPlan, type PlanAccountState } from '@/lib/chatgpt-plan/client';

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
  const [pending, setPending] = useState<ChatGPTPlanSignInStart | null>(null);
  const [pasting, setPasting] = useState(false);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<
    'sign-in' | 'paste' | 'models' | 'disconnect' | 'cancel' | 'forget' | null
  >(null);
  const [error, setError] = useState('');
  const [welcome, setWelcome] = useState<'open' | 'saving' | 'failed' | 'dismissed'>('open');
  const [confirm, setConfirm] = useState<'disconnect' | 'forget' | null>(null);

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
    const answer = await callChatGPTPlan<{ models: ChatGPTPlanModel[] }>(CHATGPT_PLAN_API.models);
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

  const finishAttempt = useCallback(
    async (outcome: ChatGPTPlanAttemptOutcome, cancelled = false) => {
      if (outcome === 'pending') return;
      if (outcome === 'connected' || outcome === 'sharing-disabled') {
        await connected();
        return;
      }
      setPending(null);
      setAddress('');
      if (!cancelled) failed({ reason: outcome });
    },
    [connected, failed],
  );

  // Poll this attempt, even when a refused retry leaves the account in the same state.
  useEffect(() => {
    if (!pending || pending.flow !== 'loopback') return;
    const { attemptId, expiresAt } = pending;
    let active = true;
    let timer = setTimeout(check, 2000);
    async function check() {
      const answer = await callChatGPTPlan<{ outcome: ChatGPTPlanAttemptOutcome }>(
        CHATGPT_PLAN_API.attempt,
        { attemptId },
      );
      if (!active) return;
      if (answer.ok && answer.data.outcome !== 'pending') {
        await finishAttempt(answer.data.outcome);
      } else if (Date.now() >= expiresAt) {
        await finishAttempt('sign-in-expired');
      } else {
        if (!answer.ok) failed(answer);
        timer = setTimeout(check, 2000);
      }
    }
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, finishAttempt, failed]);

  const cancelSignIn = async () => {
    if (!pending) return;
    setError('');
    setBusy('cancel');
    const answer = await callChatGPTPlan<{ outcome: ChatGPTPlanAttemptOutcome }>(
      CHATGPT_PLAN_API.attempt,
      { attemptId: pending.attemptId, cancel: true },
    );
    setBusy(null);
    if (!answer.ok) return failed(answer);
    await finishAttempt(answer.data.outcome, true);
  };

  const acceptNotice = async () => {
    setWelcome('saving');
    const answer = await callChatGPTPlan(CHATGPT_PLAN_API.notice, {});
    if (!answer.ok) return setWelcome('failed');
    setWelcome('dismissed');
    await loadStatus();
  };

  const signIn = async () => {
    setError('');
    setBusy('sign-in');
    // Opened within the click, so the browser lets it through; filled in below.
    const tab = window.open('', '_blank');
    const answer = await callChatGPTPlan<{ signIn: ChatGPTPlanSignInStart }>(
      CHATGPT_PLAN_API.signIn,
      {},
    );
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
    setPending(start);
    setPasting(start.flow === 'paste');
  };

  const submitAddress = async () => {
    if (!pending) return;
    setError('');
    setBusy('paste');
    const { attemptId } = pending;
    const answer = await callChatGPTPlan(CHATGPT_PLAN_API.callback, { address, attemptId });
    setBusy(null);
    if (!answer.ok) {
      // A mistyped URL can be corrected; a consumed authorization needs a new sign-in.
      const attempt = await callChatGPTPlan<{ outcome: ChatGPTPlanAttemptOutcome }>(
        CHATGPT_PLAN_API.attempt,
        { attemptId },
      );
      if (attempt.ok && attempt.data.outcome !== 'pending')
        await finishAttempt(attempt.data.outcome);
      else failed(answer);
      return;
    }
    await connected();
  };

  const disconnect = async () => {
    setBusy('disconnect');
    const answer = await callChatGPTPlan<{ revoked: boolean }>(CHATGPT_PLAN_API.disconnect, {});
    setBusy(null);
    if (!answer.ok) return failed(answer);
    if (!answer.data.revoked) toast.warning(t('settings.chatgptPlan.notRevoked'));
    setPending(null);
    await loadStatus();
  };

  const forgetRegistration = async () => {
    setError('');
    setBusy('forget');
    const answer = await callChatGPTPlan(CHATGPT_PLAN_API.forget, {});
    setBusy(null);
    if (!answer.ok) return failed(answer);
    setWelcome('open');
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
    <Button
      data-oai-siwc-button=""
      size="sm"
      className="bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85"
      onClick={signIn}
      disabled={busy !== null}
    >
      {busy === 'sign-in' ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <img src="/logos/openai.svg" alt="" className="size-4 invert dark:invert-0" />
      )}
      {label}
    </Button>
  );
  const disconnectButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setConfirm('disconnect')}
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
            onClick={cancelSignIn}
            disabled={busy !== null}
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
                aria-label={t('settings.chatgptPlan.returnAddress')}
                autoComplete="off"
                spellCheck={false}
                placeholder="http://127.0.0.1:…"
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
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('settings.chatgptPlan.signInHint')}</p>
        <div className="flex flex-wrap gap-2">
          {signInButton(t('settings.chatgptPlan.signIn'))}
          {status.canForgetRegistration && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirm('forget')}
              disabled={busy !== null}
            >
              {t('settings.chatgptPlan.differentAccount')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {body}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <AlertDialog
        open={status.state === 'connected' && !status.noticeAcknowledged && welcome !== 'dismissed'}
        onOpenChange={(open) => {
          if (!open && welcome === 'failed') setWelcome('dismissed');
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.chatgptPlan.usingPlan')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.chatgptPlan.noticeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {welcome === 'failed' && (
            <p role="alert" className="text-sm text-destructive">
              {t('settings.chatgptPlan.errorFailed')}
            </p>
          )}
          <AlertDialogFooter>
            {usageLink}
            {welcome === 'failed' && <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>}
            <Button onClick={acceptNotice} disabled={welcome === 'saving'}>
              {t('settings.chatgptPlan.noticeAccept')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                confirm === 'forget'
                  ? 'settings.chatgptPlan.differentAccount'
                  : 'settings.chatgptPlan.disconnect',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                confirm === 'forget'
                  ? 'settings.chatgptPlan.forgetConfirm'
                  : 'settings.chatgptPlan.disconnectConfirm',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirm === 'forget' ? forgetRegistration : disconnect}>
              {t(
                confirm === 'forget'
                  ? 'settings.chatgptPlan.differentAccount'
                  : 'settings.chatgptPlan.disconnect',
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
