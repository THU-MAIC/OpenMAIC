'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { pblRequest } from './request';
import { useI18n } from '@/lib/hooks/use-i18n';
import { SandboxRequestError } from '@/components/sandbox/client';

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
  request: Omit<ApplicationLaunch, 'action'> & {
    action: ApplicationLaunch['action'] | 'status' | 'frontend';
  },
  signal: AbortSignal,
  assertCurrent: () => void = () => signal.throwIfAborted(),
  acknowledge?: () => void,
  retryStudyContention = false,
  observeAfterLaunch = false,
) {
  assertCurrent();
  // A busy response can be reconciled with the same request and durable launch receipt.
  // Network failures have no such acknowledgement and require explicit recovery.
  const contentionRetries = retryStudyContention ? 30 : 2;
  const observe = async (input = request) => {
    for (let contention = 0; ; contention++) {
      assertCurrent();
      try {
        return await pblRequest<ApplicationObservation>('/api/pbl/v3/application', input, signal);
      } catch (error) {
        if (
          retryStudyContention &&
          input.action === 'status' &&
          error instanceof SandboxRequestError &&
          error.reason === 'PROGRESS_CHANGED' &&
          contention < 2
        ) {
          // The standalone probe can cross a process stop before the next
          // learning event arrives. Re-observe; a newer view aborts this request.
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (
          !(error instanceof SandboxRequestError) ||
          (error.reason !== 'ENVIRONMENT_BUSY' &&
            !(
              retryStudyContention &&
              (error.reason === 'STUDY_BUSY' ||
                (input.action === 'status' && error.reason === 'WORKSPACE_COMMAND_ACTIVE'))
            )) ||
          contention >= contentionRetries
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  let result = await observe();
  acknowledge?.();
  assertCurrent();
  const deadline = Date.now() + 20_000;
  const readinessRequest = observeAfterLaunch ? { ...request, action: 'status' as const } : request;
  for (
    let retry = 0;
    result.state === 'starting' &&
    retry < 20 &&
    Date.now() < deadline &&
    !(readinessRequest.action === 'status' && result.sourceChanged);
    retry++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertCurrent();
    result = await observe(readinessRequest);
    acknowledge?.();
    assertCurrent();
  }
  return result;
}

export function useApplicationPreview(
  view: LearningView | null,
  workbench: LearningWorkbench | null,
  dirty: boolean,
  autoOpen = true,
  learningActionPending = false,
) {
  const { t } = useI18n();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const autoLaunched = useRef<string | null>(null);
  const rejectedAutomaticLaunch = useRef<{ binding: string; revision: number } | null>(null);
  const closedStudy = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [observation, setObservation] = useState<ApplicationObservation | null>(null);
  const standaloneFrontend = view?.application?.standaloneFrontend === true;
  const deferAutomatic = standaloneFrontend && learningActionPending;
  const deferAutomaticRef = useRef(deferAutomatic);
  deferAutomaticRef.current = deferAutomatic;
  const [frontend, setFrontend] = useState<{
    binding: string;
    grant?: ApplicationObservation['preview'];
    error?: string;
  } | null>(null);
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
  const applicationDeclared = !!view?.application;
  // Quiz narration is read-only. Recover the app stopped by tests while it streams.
  const quizNarration =
    standaloneFrontend &&
    view?.role === 'mentor' &&
    view.stage?.kind === 'check' &&
    view.stage.checker === 'quiz';
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
  const reviewReady = view?.conversation?.some(
    (entry) =>
      entry.status === 'running' &&
      entry.parts.some(
        (part) => part.kind === 'tool' && part.action === 'review' && part.status === 'succeeded',
      ),
  );
  // A successful review tool is the existing server-enforced write checkpoint.
  // The remaining streamed reply need not hold the learner's preview hostage.
  const sourceWriting = view?.conversation?.some((entry) => {
    if (entry.status !== 'running') return false;
    const lastWrite = entry.parts.findLastIndex(
      (part) =>
        part.kind === 'tool' &&
        (part.action === 'write' || part.action === 'manage') &&
        (part.args as { path?: string } | undefined)?.path !== 'PLAN.md',
    );
    return (
      lastWrite >= 0 &&
      !entry.parts
        .slice(lastWrite + 1)
        .some(
          (part) => part.kind === 'tool' && part.action === 'review' && part.status === 'succeeded',
        )
    );
  });
  const isolatedAssessment = view?.evaluation?.isolatedSources === true;
  const disabled =
    unavailable || dirty || (!!view?.evaluation && !isolatedAssessment) || !!sourceWriting;
  const binding = `${view?.id}:${view?.environmentId}:${workbench?.environmentId}:${workbench?.epoch}`;
  const stage = `${view?.state?.position?.milestoneId}:${view?.state?.position?.stageIndex}`;
  const [observedBinding, setObservedBinding] = useState(binding);
  const currentBinding = observedBinding === binding;
  const frontendState = frontend?.binding === binding ? frontend : null;
  const document = standaloneFrontend ? frontendState?.grant : observation?.preview;
  const previewDeadline = useRef<number | undefined>(undefined);
  previewDeadline.current = document?.expiresAt;
  const hasObservation = standaloneFrontend ? !!observation : !!observation?.preview;
  // A timeout from an older grant cannot expire a later accepted renewal.
  const expired = !!document && expiredAt === document.expiresAt;
  const frontendUnavailable = t('pblV3.application.unavailable');
  const frontendStudy = view?.id;
  const frontendEnvironment = workbench?.environmentId;
  const frontendEpoch = workbench?.epoch;
  const needsFrontend =
    standaloneFrontend && currentBinding && open && !unavailable && !frontendState;
  useEffect(() => {
    if (!needsFrontend || !frontendStudy || !frontendEnvironment || frontendEpoch === undefined)
      return;
    const abort = new AbortController();
    void waitForApplication(
      {
        studyId: frontendStudy,
        environmentId: frontendEnvironment,
        epoch: frontendEpoch,
        revision: 0,
        id: crypto.randomUUID(),
        action: 'frontend',
      },
      abort.signal,
    )
      .then((result) => {
        if (!result.preview) throw new Error(frontendUnavailable);
        if (!abort.signal.aborted) setFrontend({ binding, grant: result.preview });
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setFrontend({ binding, error: error.message });
      });
    return () => abort.abort();
  }, [
    needsFrontend,
    frontendStudy,
    frontendEnvironment,
    frontendEpoch,
    binding,
    frontendUnavailable,
  ]);
  useEffect(() => {
    ++attempt.current;
    controller.current?.abort();
    setObservedBinding(binding);
    setOpen(autoOpen && applicationDeclared && closedStudy.current !== view?.id);
    setPending(false);
    setObservation(null);
    setFrontend(null);
    setError('');
    setExpiredAt(null);
    setRefreshNeeded(false);
    observedRevision.current = null;
    replacementNeeded.current = false;
    embeddedLaunch.current = null;
    documentLaunch.current = null;
    unresolvedLaunch.current = null;
    rejectedAutomaticLaunch.current = null;
  }, [binding, autoOpen, applicationDeclared, view?.id]);
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
      setFrontend(null);
      autoLaunched.current = null;
      setObservation(null);
      setRefreshNeeded(false);
      replacementNeeded.current = false;
      embeddedLaunch.current = null;
      documentLaunch.current = null;
      // An unavailable observation can be transient within the same binding.
      // Retain a dispatched receipt for reconciliation after readiness returns;
      // the binding reset above discards it when the environment really changes.
    } else setRefreshNeeded(true);
  }, [disabled, unavailable]);
  useEffect(() => {
    if (!currentBinding || !hasObservation || view?.revision === observedRevision.current) return;
    ++attempt.current;
    controller.current?.abort();
    setPending(false);
    setError('');
    setRefreshNeeded(true);
  }, [view?.revision, hasObservation, currentBinding]);
  useEffect(() => {
    if (!document) return;
    const deadline = document.expiresAt;
    const timer = setTimeout(() => setExpiredAt(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [document]);
  const frontendUrl = frontendState?.grant?.url;
  const frontendDeadline = frontendState?.grant?.expiresAt;
  useEffect(() => {
    if (
      !open ||
      unavailable ||
      !frontendUrl ||
      frontendDeadline === undefined ||
      !frontendStudy ||
      !frontendEnvironment ||
      frontendEpoch === undefined
    )
      return;
    const abort = new AbortController();
    const hostDocument = window.document;
    const renewAt = frontendDeadline - 60_000;
    let timer: ReturnType<typeof setTimeout>;
    let renewing = false;
    let consecutiveFailures = 0;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void refreshGrant(), delay);
    };
    const refreshGrant = async () => {
      if (abort.signal.aborted || renewing || hostDocument.visibilityState === 'hidden') return;
      renewing = true;
      try {
        const { preview: grant } = await pblRequest<ApplicationObservation>(
          '/api/pbl/v3/application',
          {
            studyId: frontendStudy,
            environmentId: frontendEnvironment,
            epoch: frontendEpoch,
            revision: 0,
            id: crypto.randomUUID(),
            action: 'frontend',
          },
          AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        );
        if (!grant) throw new Error('Preview authorization unavailable');
        const fresh = new URL(grant.url);
        if (fresh.origin !== new URL(frontendUrl).origin) throw new Error('Preview origin changed');
        const response = await fetch(new URL('/__openmaic_renew', fresh.origin), {
          method: 'POST',
          credentials: 'include',
          body: fresh.hash.slice(1),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        if (response.status === 403) return;
        if (!response.ok) throw new Error('Preview authorization unavailable');
        const { expiresAt } = await response.json();
        if (abort.signal.aborted) return;
        if (
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= Date.now() ||
          expiresAt > grant.expiresAt
        )
          throw new Error('Invalid preview authorization');
        // The existing iframe URL remains the document identity. Only its
        // gateway cookie and deadline are replaced.
        setFrontend((current) =>
          current?.binding === binding &&
          current.grant?.url === frontendUrl &&
          current.grant.expiresAt === frontendDeadline
            ? { ...current, grant: { ...current.grant, expiresAt } }
            : current,
        );
        consecutiveFailures = 0;
        if (expiresAt === frontendDeadline) schedule(15_000);
      } catch (error) {
        if (
          !abort.signal.aborted &&
          ++consecutiveFailures < 4 &&
          !(
            error instanceof SandboxRequestError &&
            ([401, 403].includes(error.status) ||
              ['ENVIRONMENT_UNAVAILABLE', 'ENVIRONMENT_CHANGED', 'WORKSPACE_STOPPED'].includes(
                error.reason ?? '',
              ))
          )
        )
          schedule(15_000);
      } finally {
        renewing = false;
      }
    };
    const onVisible = () => {
      if (hostDocument.visibilityState === 'visible' && Date.now() >= renewAt) {
        consecutiveFailures = 0;
        void refreshGrant();
      }
    };
    schedule(Math.max(15_000, renewAt - Date.now()));
    hostDocument.addEventListener('visibilitychange', onVisible);
    return () => {
      abort.abort();
      clearTimeout(timer);
      hostDocument.removeEventListener('visibilitychange', onVisible);
    };
  }, [
    open,
    unavailable,
    frontendUrl,
    frontendDeadline,
    frontendStudy,
    frontendEnvironment,
    frontendEpoch,
    binding,
  ]);

  const load = useCallback(
    async (action: 'open' | 'restart', recovery?: 'automatic' | 'explicit') => {
      if (!currentBinding || disabled || isolatedAssessment || !view || !workbench) return;
      if (standaloneFrontend && recovery === 'explicit' && (expired || frontendState?.error))
        setFrontend(null);
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
      const checking = !!recovery && hasObservation && !expired;
      // Status probes never take input away from a currently displayed page.
      setPending(!checking);
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
        if (!resumable && recovery && hasObservation) {
          const status = await waitForApplication(
            { ...request, action: 'status' },
            abort.signal,
            assertCurrent,
            undefined,
            standaloneFrontend,
          );
          if (serial !== attempt.current) return;
          if (
            (status.state === 'running' || status.state === 'starting') &&
            !status.sourceChanged &&
            (standaloneFrontend ||
              (!replacementNeeded.current && previewDeadline.current! > Date.now()))
          ) {
            observedRevision.current = view.revision;
            setObservation((current) => ({ ...status, preview: current?.preview }));
            return;
          }
          if (['running', 'starting'].includes(status.state) && status.sourceChanged)
            request.action = 'restart';
        }
        if (recovery === 'automatic' && deferAutomaticRef.current) {
          setRefreshNeeded(true);
          return;
        }
        setPending(true);
        if (!standaloneFrontend) {
          // Only process-served pages need a replacement document after launch.
          replacementNeeded.current = true;
          embeddedLaunch.current = serial;
        }
        const launch = resumable ?? { binding, stage, request: { ...request } };
        unresolvedLaunch.current = launch;
        const result = await waitForApplication(
          request,
          abort.signal,
          assertCurrent,
          () => {
            // Even a late response acknowledges this exact launch, not a newer one.
            if (unresolvedLaunch.current === launch) unresolvedLaunch.current = null;
          },
          standaloneFrontend && (request.action === 'open' || recovery === 'automatic'),
          standaloneFrontend,
        );
        if (serial === attempt.current) {
          observedRevision.current = view.revision;
          if (standaloneFrontend && result.state === 'running') {
            setObservation(result);
          } else if (result.preview) {
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
        if (serial === attempt.current && !abort.signal.aborted) {
          if (
            e instanceof SandboxRequestError &&
            e.reason === 'PROGRESS_CHANGED' &&
            !resumable &&
            !recovery &&
            action === 'open' &&
            !observation?.preview &&
            autoLaunched.current === binding
          ) {
            // Admission rejected this fresh request before dispatch. A newer
            // teaching revision may retry; unknown outcomes must not do so.
            rejectedAutomaticLaunch.current = { binding, revision: request.revision };
            if (unresolvedLaunch.current?.request.id === request.id)
              unresolvedLaunch.current = null;
          }
          setError((e as Error).message);
        }
      } finally {
        if (serial === attempt.current) {
          controller.current = null;
          setPending(false);
        }
      }
    },
    [
      currentBinding,
      disabled,
      isolatedAssessment,
      view,
      workbench,
      observation,
      t,
      binding,
      stage,
      expired,
      standaloneFrontend,
      frontendState?.error,
      hasObservation,
    ],
  );
  useEffect(() => {
    const rejected = rejectedAutomaticLaunch.current;
    if (
      currentBinding &&
      rejected?.binding === binding &&
      view &&
      view.revision > rejected.revision
    ) {
      rejectedAutomaticLaunch.current = null;
      autoLaunched.current = null;
      setError('');
    }
  }, [currentBinding, binding, view?.revision, error, view]);
  useEffect(() => {
    if (
      !autoOpen ||
      deferAutomatic ||
      !currentBinding ||
      disabled ||
      isolatedAssessment ||
      !view?.application ||
      closedStudy.current === view.id ||
      autoLaunched.current === binding ||
      pending ||
      observation ||
      error
    )
      return;
    // Let effect cleanup cancel an undispatched automatic launch (including
    // StrictMode's setup/cleanup probe), rather than leaving a consumed attempt.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      autoLaunched.current = binding;
      void load('open');
    });
    return () => {
      cancelled = true;
    };
  }, [
    autoOpen,
    deferAutomatic,
    currentBinding,
    disabled,
    isolatedAssessment,
    view,
    binding,
    pending,
    observation,
    error,
    load,
  ]);
  useEffect(() => {
    if (
      currentBinding &&
      open &&
      refreshNeeded &&
      !deferAutomatic &&
      !isolatedAssessment &&
      !disabled &&
      (!view?.busy || reviewReady || quizNarration) &&
      !pending &&
      !expired &&
      (!document || document.expiresAt > Date.now())
    )
      void load('open', 'automatic');
  }, [
    currentBinding,
    open,
    refreshNeeded,
    deferAutomatic,
    isolatedAssessment,
    disabled,
    pending,
    expired,
    document,
    load,
    view?.busy,
    reviewReady,
    quizNarration,
  ]);
  const renew = useCallback(
    (expiresAt: number) => {
      if (
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > Date.now() + 300_000
      )
        return;
      if (standaloneFrontend) {
        setFrontend((current) =>
          current?.grant && current.binding === binding && expiresAt > current.grant.expiresAt
            ? { ...current, grant: { ...current.grant, expiresAt } }
            : current,
        );
        return;
      }
      setObservation((current) =>
        current?.preview && expiresAt > current.preview.expiresAt
          ? { ...current, preview: { ...current.preview, expiresAt } }
          : current,
      );
    },
    [binding, standaloneFrontend],
  );
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
          action: standaloneFrontend ? 'frontend' : 'open',
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
      if (serial === attempt.current) {
        controller.current = null;
        setPending(false);
      }
    }
  }
  function close() {
    closedStudy.current = view?.id ?? null;
    if (pending || (controller.current && !controller.current.signal.aborted)) {
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
      closedStudy.current = null;
      setOpen(true);
      if (
        !document ||
        (standaloneFrontend && observation?.state !== 'running') ||
        expired ||
        document.expiresAt <= Date.now() ||
        refreshNeeded ||
        replacementNeeded.current
      ) {
        if (isolatedAssessment) setRefreshNeeded(true);
        else void load('open', refreshNeeded || standaloneFrontend ? 'explicit' : undefined);
      }
    }
  }
  return {
    panelId,
    open: open && currentBinding,
    pending,
    observation: currentBinding && !unavailable ? observation : null,
    document: currentBinding && !unavailable ? document : undefined,
    standaloneFrontend,
    frontendPending: needsFrontend,
    reloadFrontend: () => setFrontend(null),
    error: standaloneFrontend ? frontendState?.error : error,
    applicationError: standaloneFrontend ? error : undefined,
    expired,
    disabled,
    launchPaused: isolatedAssessment,
    dirty,
    updating: disabled || pending,
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
