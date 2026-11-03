'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { pblRequest } from './request';
import { useI18n } from '@/lib/hooks/use-i18n';

interface ApplicationLaunch {
  studyId: string;
  environmentId: string;
  revision: number;
  epoch: number;
  id: string;
  action: 'open' | 'restart';
}

/** Readiness retries retain one launch receipt in both embedded and new-tab opens. */
async function waitForApplication(
  request: Omit<ApplicationLaunch, 'action'> & { action: ApplicationLaunch['action'] | 'status' },
  signal: AbortSignal,
  assertCurrent: () => void = () => signal.throwIfAborted(),
  acknowledge?: () => void,
) {
  assertCurrent();
  let result = await pblRequest<ApplicationObservation>('/api/pbl/v3/application', request, signal);
  acknowledge?.();
  assertCurrent();
  for (
    let retry = 0;
    result.state === 'starting' &&
    retry < 3 &&
    !(request.action === 'status' && result.sourceChanged);
    retry++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertCurrent();
    result = await pblRequest<ApplicationObservation>('/api/pbl/v3/application', request, signal);
    acknowledge?.();
    assertCurrent();
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
  // A dispatched launch may finish after its fetch is cancelled or fails.
  // Keep the old page visible, but do not reuse it as the restarted app's page.
  const replacementNeeded = useRef(false);
  // Request cancellation also happens on pause/status checks. Only another
  // embedded launch can supersede a candidate's process continuity evidence.
  const embeddedLaunch = useRef<number | null>(null);
  const documentLaunch = useRef<number | null>(null);
  const unresolvedLaunch = useRef<{
    binding: string;
    stage: string;
    request: ApplicationLaunch;
  } | null>(null);
  const previewDeadline = useRef<number | undefined>(undefined);
  previewDeadline.current = observation?.preview?.expiresAt;
  const hasPreview = !!observation?.preview;
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
  const stage = `${view?.state?.position?.milestoneId}:${view?.state?.position?.stageIndex}`;
  const [observedBinding, setObservedBinding] = useState(binding);
  const currentBinding = observedBinding === binding;
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
    replacementNeeded.current = false;
    embeddedLaunch.current = null;
    documentLaunch.current = null;
    unresolvedLaunch.current = null;
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
      replacementNeeded.current = false;
      embeddedLaunch.current = null;
      documentLaunch.current = null;
      unresolvedLaunch.current = null;
    } else setRefreshNeeded(true);
  }, [disabled, unavailable]);
  useEffect(() => {
    if (!currentBinding || !hasPreview || view?.revision === observedRevision.current) return;
    ++attempt.current;
    controller.current?.abort();
    setPending(false);
    setError('');
    setRefreshNeeded(true);
  }, [view?.revision, hasPreview, currentBinding]);
  useEffect(() => {
    if (!observation?.preview) return;
    const deadline = observation.preview.expiresAt;
    const timer = setTimeout(() => setExpiredAt(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [observation]);

  const load = useCallback(
    async (action: 'open' | 'restart', recovery?: 'automatic' | 'explicit') => {
      if (!currentBinding || disabled || !view || !workbench) return;
      const expiredRecovery = () =>
        recovery === 'automatic' &&
        previewDeadline.current !== undefined &&
        previewDeadline.current <= Date.now();
      if (expiredRecovery()) return;
      const serial = ++attempt.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setOpen(true);
      setPending(true);
      setError('');
      setRefreshNeeded(false);
      const original = unresolvedLaunch.current;
      const resumable =
        original &&
        original.binding === binding &&
        original.stage === stage &&
        original.request.revision === view.revision &&
        (action === 'open' || original.request.action === action)
          ? original
          : null;
      // A newer workspace version supersedes the old request. The backend checks
      // revision before receipt lookup; never mutate an ID's inputs or replay stale work.
      if (original && !resumable) unresolvedLaunch.current = null;
      const request: ApplicationLaunch = resumable
        ? { ...resumable.request }
        : {
            studyId: view.id,
            environmentId: workbench.environmentId,
            revision: view.revision,
            epoch: workbench.epoch,
            id: crypto.randomUUID(),
            action,
          };
      const assertCurrent = () => {
        if (serial !== attempt.current) abort.abort();
        if (serial === attempt.current && expiredRecovery()) {
          setExpiredAt(previewDeadline.current!);
          setRefreshNeeded(true);
          abort.abort();
        }
        abort.signal.throwIfAborted();
      };
      try {
        if (!resumable && recovery && observation?.preview) {
          const status = await waitForApplication(
            { ...request, action: 'status' },
            abort.signal,
            assertCurrent,
          );
          if (serial !== attempt.current) return;
          if (
            (status.state === 'running' || status.state === 'starting') &&
            !status.sourceChanged &&
            !replacementNeeded.current &&
            previewDeadline.current! > Date.now()
          ) {
            observedRevision.current = view.revision;
            setObservation((current) => ({ ...status, preview: current?.preview }));
            return;
          }
          if (['running', 'starting'].includes(status.state) && status.sourceChanged)
            request.action = 'restart';
        }
        // A ticket is not a usable document, including on the first launch.
        replacementNeeded.current = true;
        embeddedLaunch.current = serial;
        const launch = resumable ?? { binding, stage, request: { ...request } };
        unresolvedLaunch.current = launch;
        const result = await waitForApplication(request, abort.signal, assertCurrent, () => {
          // Even a late response acknowledges this exact launch, not a newer one.
          if (unresolvedLaunch.current === launch) unresolvedLaunch.current = null;
        });
        if (serial === attempt.current) {
          observedRevision.current = view.revision;
          if (result.preview) {
            documentLaunch.current = serial;
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
    [currentBinding, disabled, view, workbench, observation, t, binding, stage],
  );
  useEffect(() => {
    if (
      currentBinding &&
      open &&
      refreshNeeded &&
      !disabled &&
      !pending &&
      !expired &&
      (!observation?.preview || observation.preview.expiresAt > Date.now())
    )
      void load('open', 'automatic');
  }, [currentBinding, open, refreshNeeded, disabled, pending, expired, observation, load]);
  const renew = useCallback((expiresAt: number) => {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300_000)
      return;
    setObservation((current) =>
      current?.preview && expiresAt > current.preview.expiresAt
        ? { ...current, preview: { ...current.preview, expiresAt } }
        : current,
    );
  }, []);
  const documentReady = useCallback(
    (version: number) => {
      if (
        version === frameVersion &&
        documentLaunch.current !== null &&
        documentLaunch.current === embeddedLaunch.current
      )
        replacementNeeded.current = false;
    },
    [frameVersion],
  );
  async function openNewTab() {
    if (!currentBinding || disabled || pending || !view || !workbench) return;
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
        refreshNeeded ||
        replacementNeeded.current
      )
        void load('open', refreshNeeded ? 'explicit' : undefined);
    }
  }
  return {
    panelId,
    open: open && currentBinding,
    pending,
    observation: currentBinding && !unavailable ? observation : null,
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
    documentReady,
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
