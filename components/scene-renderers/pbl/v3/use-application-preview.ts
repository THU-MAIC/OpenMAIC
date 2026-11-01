'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { pblRequest } from './request';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Readiness retries retain one launch receipt in both embedded and new-tab opens. */
async function waitForApplication(request: Record<string, unknown>, signal: AbortSignal) {
  let result = await pblRequest<ApplicationObservation>('/api/pbl/v3/application', request, signal);
  for (let retry = 0; result.state === 'starting' && retry < 3; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    signal.throwIfAborted();
    result = await pblRequest<ApplicationObservation>('/api/pbl/v3/application', request, signal);
  }
  return result;
}

export function useApplicationPreview(
  view: LearningView | null,
  workbench: LearningWorkbench | null,
  dirty: boolean,
) {
  const { t } = useI18n();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [observation, setObservation] = useState<ApplicationObservation | null>(null);
  const [error, setError] = useState('');
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const observedRevision = useRef<number | null>(null);
  // A timeout from an older grant cannot expire a later accepted renewal.
  const expired = !!observation?.preview && expiredAt === observation.preview.expiresAt;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const setTrigger = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
  }, []);
  const attempt = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const unavailable =
    !view ||
    !view.application ||
    !view.environment?.ready ||
    !workbench ||
    !view.environmentId ||
    workbench.environmentId !== view.environmentId;
  const disabled = unavailable || dirty || !!view?.busy || !!view?.evaluation;
  const binding = `${view?.id}:${view?.environmentId}:${workbench?.environmentId}:${workbench?.epoch}`;
  const [observedBinding, setObservedBinding] = useState(binding);
  useEffect(() => {
    ++attempt.current;
    controller.current?.abort();
    setObservedBinding(binding);
    setOpen(false);
    setPending(false);
    setObservation(null);
    setError('');
    setExpiredAt(null);
    setRefreshNeeded(false);
    observedRevision.current = null;
  }, [binding]);
  useEffect(
    () => () => {
      ++attempt.current;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!disabled) return;
    // Suspend input during work, but keep the last rendered document visible.
    // Only a revoked/unavailable environment discards it.
    ++attempt.current;
    controller.current?.abort();
    setPending(false);
    setError('');
    if (unavailable) {
      setObservation(null);
      setRefreshNeeded(false);
    } else setRefreshNeeded(true);
  }, [disabled, unavailable]);
  useEffect(() => {
    if (!observation?.preview || view?.revision === observedRevision.current) return;
    ++attempt.current;
    controller.current?.abort();
    setPending(false);
    setError('');
    setRefreshNeeded(true);
  }, [view?.revision, observation?.preview]);
  useEffect(() => {
    if (!observation?.preview) return;
    const deadline = observation.preview.expiresAt;
    const timer = setTimeout(() => setExpiredAt(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [observation]);

  const load = useCallback(
    async (action: 'open' | 'restart', refresh = false) => {
      if (disabled || !view || !workbench) return;
      const serial = ++attempt.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setOpen(true);
      setPending(true);
      setError('');
      setRefreshNeeded(false);
      const request = {
        studyId: view.id,
        environmentId: workbench.environmentId,
        revision: view.revision,
        epoch: workbench.epoch,
        id: crypto.randomUUID(),
        action,
      };
      try {
        if (refresh && observation?.preview) {
          const status = await pblRequest<ApplicationObservation>(
            '/api/pbl/v3/application',
            { ...request, action: 'status' },
            abort.signal,
          );
          if (serial !== attempt.current) return;
          if (
            status.state === 'running' &&
            !status.sourceChanged &&
            observation.preview.expiresAt > Date.now()
          ) {
            observedRevision.current = view.revision;
            setObservation({ ...status, preview: observation.preview });
            return;
          }
          if (status.state === 'running' && status.sourceChanged) request.action = 'restart';
        }
        const result = await waitForApplication(request, abort.signal);
        if (serial === attempt.current) {
          observedRevision.current = view.revision;
          if (result.preview) {
            setExpiredAt(null);
            setObservation(result);
            setFrameVersion((value) => value + 1);
          } else {
            setObservation((current) =>
              current?.preview ? { ...result, preview: current.preview } : result,
            );
            setError(
              t(
                result.state === 'failed'
                  ? 'pblV3.application.failed'
                  : 'pblV3.application.unavailable',
              ),
            );
          }
        }
      } catch (e) {
        if (serial === attempt.current && !abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (serial === attempt.current) setPending(false);
      }
    },
    [disabled, view, workbench, observation, t],
  );
  useEffect(() => {
    if (open && refreshNeeded && !disabled && !pending) void load('open', true);
  }, [open, refreshNeeded, disabled, pending, load]);
  const renew = useCallback((expiresAt: number) => {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300_000)
      return;
    setObservation((current) =>
      current?.preview && expiresAt > current.preview.expiresAt
        ? { ...current, preview: { ...current.preview, expiresAt } }
        : current,
    );
  }, []);
  async function openNewTab() {
    if (disabled || pending || !view || !workbench) return;
    // A renewed iframe cookie belongs to its embedding partition. Obtain a fresh
    // owner-authorized ticket for the separate tab without reloading this iframe.
    const tab = window.open('about:blank', '_blank');
    if (!tab) return;
    tab.opener = null;
    const referrer = tab.document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    tab.document.head.append(referrer);
    const serial = ++attempt.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError('');
    try {
      const result = await waitForApplication(
        {
          studyId: view.id,
          environmentId: workbench.environmentId,
          revision: view.revision,
          epoch: workbench.epoch,
          id: crypto.randomUUID(),
          action: 'open',
        },
        abort.signal,
      );
      if (serial !== attempt.current) tab.close();
      else if (!result.preview) {
        tab.close();
        setError(t('pblV3.application.unavailable'));
      } else tab.location.replace(result.preview.url);
    } catch (e) {
      tab.close();
      if (serial === attempt.current && !abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (serial === attempt.current) setPending(false);
    }
  }
  function close() {
    if (pending) {
      ++attempt.current;
      controller.current?.abort();
      setPending(false);
      setRefreshNeeded(true);
    }
    setOpen(false);
    trigger.current?.focus();
  }
  function toggle() {
    if (open) close();
    else if (!disabled) {
      setOpen(true);
      if (
        !observation?.preview ||
        expired ||
        observation.preview.expiresAt <= Date.now() ||
        refreshNeeded
      )
        void load('open', refreshNeeded);
    }
  }
  return {
    panelId,
    open: open && observedBinding === binding,
    pending,
    observation: observedBinding === binding && !unavailable ? observation : null,
    error,
    expired,
    disabled,
    dirty,
    updating:
      disabled ||
      pending ||
      refreshNeeded ||
      (!!observation?.preview && view?.revision !== observedRevision.current),
    frameVersion,
    documentScope: `${binding}:${unavailable}`,
    setTrigger,
    close,
    toggle,
    load,
    renew,
    openNewTab,
  };
}

export type ApplicationPreviewController = ReturnType<typeof useApplicationPreview>;
