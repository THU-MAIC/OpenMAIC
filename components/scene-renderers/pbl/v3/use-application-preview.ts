'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { pblRequest } from './request';

export function useApplicationPreview(
  view: LearningView | null,
  workbench: LearningWorkbench | null,
  dirty: boolean,
) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [observation, setObservation] = useState<ApplicationObservation | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const setTrigger = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
  }, []);
  const attempt = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const disabled =
    !view ||
    !view.application ||
    dirty ||
    view.busy ||
    !!view.evaluation ||
    !view.environment?.ready ||
    !workbench ||
    !view.environmentId ||
    workbench.environmentId !== view.environmentId;
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
    setExpired(false);
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
    // A file write, assessment or archive may quiesce the backend application.
    // Never leave an interactive iframe competing with that work.
    ++attempt.current;
    controller.current?.abort();
    setPending(false);
    setObservation(null);
    setError('');
  }, [disabled]);
  useEffect(() => {
    if (!observation?.preview) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, observation.preview.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [observation]);

  async function load(action: 'open' | 'restart') {
    if (disabled || !view || !workbench) return;
    const serial = ++attempt.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setOpen(true);
    setPending(true);
    setError('');
    setObservation(null);
    setExpired(false);
    const request = {
      studyId: view.id,
      environmentId: workbench.environmentId,
      revision: view.revision,
      epoch: workbench.epoch,
      id: crypto.randomUUID(),
      action,
    };
    try {
      let result = await pblRequest<ApplicationObservation>(
        '/api/pbl/v3/application',
        request,
        abort.signal,
      );
      // Reuse the existing receipt; slow startup must not dispatch a second server.
      for (let retry = 0; result.state === 'starting' && retry < 3; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        abort.signal.throwIfAborted();
        result = await pblRequest<ApplicationObservation>(
          '/api/pbl/v3/application',
          request,
          abort.signal,
        );
      }
      if (serial === attempt.current) setObservation(result);
    } catch (e) {
      if (serial === attempt.current && !abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (serial === attempt.current) setPending(false);
    }
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function toggle() {
    if (open) close();
    else if (!disabled) {
      setOpen(true);
      if (!observation?.preview || expired || observation.preview.expiresAt <= Date.now())
        void load('open');
    }
  }
  return {
    panelId,
    open: open && observedBinding === binding,
    pending,
    observation: observedBinding === binding ? observation : null,
    error,
    expired,
    disabled,
    dirty,
    setTrigger,
    close,
    toggle,
    load,
  };
}

export type ApplicationPreviewController = ReturnType<typeof useApplicationPreview>;
