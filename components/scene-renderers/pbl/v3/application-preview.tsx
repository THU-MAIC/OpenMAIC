'use client';
import { useEffect, useRef, useState } from 'react';
import { AppWindow, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { pblRequest } from './request';

export function ApplicationPreview({
  view,
  workbench,
  dirty,
}: {
  view: LearningView;
  workbench: LearningWorkbench | null;
  dirty: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false);
  const [observation, setObservation] = useState<ApplicationObservation | null>(null);
  const [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const attempt = useRef(0),
    controller = useRef<AbortController | null>(null);
  const disabled =
    dirty || view.busy || !!view.evaluation || !view.environment?.ready || !workbench;
  useEffect(
    () => () => {
      ++attempt.current;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    ++attempt.current;
    controller.current?.abort();
    setOpen(false);
    setPending(false);
    setObservation(null);
    setError('');
  }, [view.id, workbench?.environmentId, workbench?.epoch]);
  useEffect(() => {
    if (!observation?.preview) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, observation.preview.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [observation]);
  async function load(action: 'open' | 'restart') {
    if (disabled || !workbench) return;
    const serial = ++attempt.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPortalContainer(
      trigger.current?.closest<HTMLElement>('[data-pbl-v3-portal]') ??
        (document.fullscreenElement as HTMLElement | null),
    );
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
      // Reuse the exact request receipt; slow startup cannot execute a second server.
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
  if (!view.application) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="pbl-application-open"
        disabled={disabled}
        onClick={() => void load('open')}
        title={t(
          dirty
            ? 'pblV3.application.saveFirst'
            : disabled
              ? 'pblV3.application.wait'
              : 'pblV3.application.open',
        )}
        className="inline-flex items-center gap-1.5 rounded border px-2 py-1.5 text-xs disabled:opacity-40"
      >
        <AppWindow size={15} />
        <span>{t('pblV3.application.open')}</span>
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            ++attempt.current;
            controller.current?.abort();
            setPending(false);
          }
        }}
      >
        <DialogContent
          container={portalContainer}
          overlayClassName="z-[140]"
          className="z-[150] flex h-[88vh] max-w-[94vw] flex-col gap-3 p-4"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex shrink-0 items-start gap-3 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle>{view.application.title}</DialogTitle>
              <DialogDescription className="mt-1">
                {t('pblV3.application.notice')}
              </DialogDescription>
            </div>
            <button
              type="button"
              disabled={pending || disabled}
              className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs disabled:opacity-40"
              onClick={() => void load('restart')}
            >
              {pending ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {t('pblV3.application.restart')}
            </button>
            {observation?.preview && !expired && (
              <a
                href={observation.preview.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded border p-1.5"
                aria-label={t('pblV3.application.newTab')}
              >
                <ExternalLink size={15} />
              </a>
            )}
          </div>
          <p className="shrink-0 whitespace-pre-line text-xs text-muted-foreground">
            {view.application.description}
          </p>
          {observation?.sourceChanged && (
            <p role="status" className="text-sm text-amber-600">
              {t('pblV3.application.changed')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {expired ? (
            <div className="flex flex-1 items-center justify-center gap-3">
              <p>{t('pblV3.application.expired')}</p>
              <button
                className="rounded border px-3 py-2"
                disabled={pending || disabled}
                onClick={() => void load('open')}
              >
                {t('pblV3.application.reopen')}
              </button>
            </div>
          ) : observation?.preview ? (
            <iframe
              key={observation.preview.url}
              title={view.application.title}
              src={observation.preview.url}
              sandbox="allow-scripts allow-forms allow-same-origin"
              referrerPolicy="no-referrer"
              className="min-h-0 w-full flex-1 rounded-lg border bg-white"
            />
          ) : (
            <div
              role="status"
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto rounded-lg border bg-muted/30 p-6"
            >
              {pending && <LoaderCircle className="animate-spin" />}
              <p>
                {t(
                  pending
                    ? 'pblV3.application.starting'
                    : observation?.state === 'failed'
                      ? 'pblV3.application.failed'
                      : 'pblV3.application.unavailable',
                )}
              </p>
              {observation?.output && (
                <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap text-xs">
                  {observation.output}
                </pre>
              )}
              {!pending && (
                <button
                  disabled={disabled}
                  className="rounded border px-3 py-2"
                  onClick={() => void load('open')}
                >
                  {t('pblV3.application.reopen')}
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
