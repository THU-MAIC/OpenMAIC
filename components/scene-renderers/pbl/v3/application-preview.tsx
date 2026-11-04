'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ChevronRight, ExternalLink, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { ApplicationPreviewController } from './use-application-preview';

export function ApplicationPreviewToggle({ preview }: { preview: ApplicationPreviewController }) {
  const { t } = useI18n();
  const { setTrigger, disabled, open, dirty, toggle, panelId } = preview;
  return (
    <button
      ref={setTrigger}
      type="button"
      data-testid="pbl-application-open"
      disabled={disabled && !open}
      onClick={toggle}
      aria-expanded={open}
      aria-controls={panelId}
      title={t(
        open
          ? 'pblV3.application.collapse'
          : dirty
            ? 'pblV3.application.saveFirst'
            : disabled
              ? 'pblV3.application.wait'
              : 'pblV3.application.open',
      )}
      className="inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1.5 text-xs aria-expanded:bg-primary aria-expanded:text-primary-foreground disabled:opacity-40"
    >
      <AppWindow size={15} />
      <span>{t('pblV3.application.open')}</span>
    </button>
  );
}

export function ApplicationPreview({
  application,
  preview,
  inputPaused = false,
}: {
  application: NonNullable<LearningView['application']>;
  preview: ApplicationPreviewController;
  inputPaused?: boolean;
}) {
  return (
    <ApplicationPreviewContent
      key={preview.documentScope}
      application={application}
      preview={preview}
      inputPaused={inputPaused}
    />
  );
}

function ApplicationPreviewContent({
  application,
  preview,
  inputPaused,
}: {
  application: NonNullable<LearningView['application']>;
  preview: ApplicationPreviewController;
  inputPaused: boolean;
}) {
  const { t } = useI18n();
  const { pending, observation, expired, disabled } = preview;
  const mounted = !!preview.document;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const candidate = useRef<HTMLIFrameElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const lastHostFocus = useRef<HTMLElement | null>(null);
  const url = preview.document?.url;
  const [displayed, setDisplayed] = useState<{ url: string; version: number } | null>(null);
  const current = url ? { url, version: preview.frameVersion } : null;
  const currentReady =
    !!current && displayed?.url === current.url && displayed.version === current.version;
  const [readinessFailure, setReadinessFailure] = useState<{ url: string; version: number } | null>(
    null,
  );
  const readinessError =
    readinessFailure?.url === url && readinessFailure?.version === preview.frameVersion;
  const error = preview.error || (readinessError ? t('pblV3.application.unavailable') : '');
  const standalone = preview.standaloneFrontend;
  const recoverApplication = standalone && currentReady && !expired && !!preview.applicationError;
  const applicationAction = t(
    recoverApplication ? 'pblV3.application.reopen' : 'pblV3.application.restart',
  );
  const previous =
    !preview.standaloneFrontend &&
    displayed &&
    current &&
    (displayed.url !== current.url || displayed.version !== current.version)
      ? displayed
      : null;
  const available =
    !disabled &&
    mounted &&
    !expired &&
    !preview.updating &&
    !error &&
    !preview.applicationError &&
    observation?.state === 'running' &&
    !previous &&
    currentReady;
  const paused = standalone && currentReady && observation?.state === 'running' && preview.updating;
  const updating =
    !expired &&
    !error &&
    (standalone
      ? preview.open && (!currentReady || paused)
      : mounted && (preview.updating || !!previous || !currentReady));
  // Modal presentation pauses input only. Readiness and candidate promotion
  // continue independently; closing a tour must never launch a replacement.
  const inputAvailable = available && !inputPaused;
  const runId = standalone ? observation?.runId : undefined;
  const sendInput = useCallback(
    (element: HTMLIFrameElement | null) => {
      if (!element) return;
      const target = new URL(element.src);
      if (target.pathname !== '/__openmaic_preview') return;
      element.contentWindow?.postMessage(
        {
          type: 'openmaic-preview-input',
          enabled: !!inputAvailable && preview.open && element === frame.current,
          ...(runId ? { runId } : {}),
        },
        target.origin,
      );
    },
    [inputAvailable, preview.open, runId],
  );
  useLayoutEffect(() => {
    sendInput(frame.current);
    if (candidate.current !== frame.current) sendInput(candidate.current);
  }, [sendInput, url, previous?.url, preview.frameVersion]);
  useLayoutEffect(() => {
    const owner = panel.current?.closest('.pbl-workbench');
    if (!owner || !preview.open || !inputAvailable) return;
    const activity = (event: Event) => {
      const element = frame.current;
      if (!event.isTrusted || !element) return;
      const target = new URL(element.src);
      if (target.pathname !== '/__openmaic_preview') return;
      // Genuine workbench use also keeps this visible preview authorized.
      // The isolated shell validates parent+origin and coalesces renewals.
      element.contentWindow?.postMessage({ type: 'openmaic-preview-host-activity' }, target.origin);
    };
    for (const name of ['pointerdown', 'keydown', 'wheel'])
      owner.addEventListener(name, activity, { capture: true, passive: true });
    return () => {
      for (const name of ['pointerdown', 'keydown', 'wheel'])
        owner.removeEventListener(name, activity, true);
    };
  }, [preview.open, inputAvailable, url, preview.frameVersion]);
  useLayoutEffect(() => {
    // Inert/pointer rules do not evacuate an already focused nested document.
    // Move only preview-owned focus; never steal focus from the learner's editor/chat.
    if ((!inputAvailable || !preview.open) && document.activeElement === frame.current)
      panel.current?.focus({ preventScroll: true });
  }, [inputAvailable, preview.open]);
  useLayoutEffect(() => {
    let deferred: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== frame.current &&
        active !== candidate.current
      )
        lastHostFocus.current = active;
    };
    const reclaim = () => {
      if (inputAvailable && preview.open) return;
      clearTimeout(deferred);
      // Nested focus() finishes after the parent blur handler/microtask. This
      // restores host focus only; the shell's document inertness blocks input.
      deferred = setTimeout(() => {
        if (!document.hasFocus() || document.visibilityState !== 'visible') return;
        const active = document.activeElement;
        if (active !== frame.current && active !== candidate.current) return;
        const prior = lastHostFocus.current;
        const target =
          prior?.isConnected &&
          !prior.closest('[inert]') &&
          !prior.matches(':disabled') &&
          prior.getClientRects().length
            ? prior
            : preview.open
              ? panel.current
              : panel.current?.closest<HTMLElement>('[data-pbl-focus-owner]');
        target?.focus({ preventScroll: true });
      }, 0);
    };
    remember();
    document.addEventListener('focusin', remember, true);
    window.addEventListener('blur', reclaim, true);
    return () => {
      clearTimeout(deferred);
      document.removeEventListener('focusin', remember, true);
      window.removeEventListener('blur', reclaim, true);
    };
  }, [inputAvailable, preview.open]);
  useLayoutEffect(() => {
    if (!url || currentReady) return;
    const timer = setTimeout(
      () => setReadinessFailure({ url, version: preview.frameVersion }),
      standalone ? 15_000 : 60_000,
    );
    return () => clearTimeout(timer);
  }, [url, preview.frameVersion, currentReady, standalone]);
  const renew = preview.renew;
  const documentReady = preview.documentReady;
  useLayoutEffect(() => {
    if (!url) return;
    const origin = new URL(previous?.url ?? url).origin;
    const candidateOrigin = new URL(url).origin;
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'openmaic-preview-input-request') {
        for (const element of [frame.current, candidate.current])
          if (
            element &&
            event.source === element.contentWindow &&
            event.origin === new URL(element.src).origin
          )
            sendInput(element);
      }
      if (event.source === candidate.current?.contentWindow && event.origin === candidateOrigin) {
        if (event.data?.type === 'openmaic-preview-ready') {
          setReadinessFailure(null);
          setDisplayed({ url, version: preview.frameVersion });
          documentReady(preview.frameVersion);
        } else if (event.data?.type === 'openmaic-preview-error')
          setReadinessFailure({ url, version: preview.frameVersion });
      }
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === origin &&
        event.data?.type === 'openmaic-preview-activity'
      )
        renew(event.data.expiresAt);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [url, previous?.url, preview.frameVersion, renew, documentReady, sendInput]);
  const status = !available && !updating && (!standalone || !currentReady || expired) && (
    <div
      role="status"
      className={
        mounted && !expired
          ? 'absolute left-3 right-3 top-3 z-10 flex max-h-full flex-wrap items-center justify-center gap-2 overflow-auto rounded-lg border bg-background/95 p-3 text-center text-sm text-muted-foreground shadow-sm'
          : 'flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center text-sm text-muted-foreground'
      }
    >
      {(pending || preview.frontendPending || preview.updating || !!previous) && (
        <LoaderCircle size={16} className="shrink-0 animate-spin" />
      )}
      {!error && (
        <p>
          {t(
            expired
              ? 'pblV3.application.expired'
              : disabled
                ? preview.dirty
                  ? 'pblV3.application.saveFirst'
                  : 'pblV3.application.wait'
                : pending || preview.frontendPending || observation?.state === 'starting'
                  ? 'pblV3.application.starting'
                  : observation?.state === 'failed'
                    ? 'pblV3.application.failed'
                    : observation
                      ? 'pblV3.application.unavailable'
                      : 'pblV3.application.ready',
          )}
        </p>
      )}
      {observation?.output && (
        <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap text-left text-xs">
          {observation.output}
        </pre>
      )}
      {((standalone && !!error) || (!pending && !preview.frontendPending && !disabled)) && (
        <button
          type="button"
          className="rounded border px-3 py-2 text-foreground"
          onClick={() => {
            if (standalone && error) preview.reloadFrontend();
            else void preview.load('open', 'explicit');
          }}
        >
          {t('pblV3.application.reopen')}
        </button>
      )}
    </div>
  );
  return (
    <section
      ref={panel}
      tabIndex={-1}
      id={preview.panelId}
      aria-label={application.title}
      aria-hidden={!preview.open}
      inert={!preview.open}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      data-testid="pbl-application-panel"
    >
      <header className="relative flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
        <AppWindow size={15} className="shrink-0" />
        <h3 className="min-w-0 flex-1 truncate font-semibold">{application.title}</h3>
        <details>
          <summary
            aria-label={t('pblV3.application.help')}
            title={t('pblV3.application.help')}
            className="cursor-pointer list-none rounded p-1 hover:bg-muted"
          >
            <Info size={15} />
          </summary>
          <div className="absolute left-3 right-3 top-full z-30 space-y-2 rounded border bg-popover p-3 text-popover-foreground shadow-lg">
            <p className="whitespace-pre-line">{application.description}</p>
            <p className="text-muted-foreground">{t('pblV3.application.notice')}</p>
            {preview.applicationError && <p>{preview.applicationError}</p>}
            {standalone && observation?.output && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{observation.output}</pre>
            )}
          </div>
        </details>
        <button
          type="button"
          disabled={pending || disabled || preview.launchPaused}
          className="rounded p-1 hover:bg-muted disabled:opacity-40"
          title={applicationAction}
          aria-label={applicationAction}
          onClick={() =>
            recoverApplication
              ? void preview.load('open', 'explicit')
              : void preview.load('restart')
          }
        >
          {pending ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        </button>
        {available && (
          <button
            type="button"
            disabled={pending}
            title={t('pblV3.application.newTab')}
            aria-label={t('pblV3.application.newTab')}
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            onClick={() => void preview.openNewTab()}
          >
            <ExternalLink size={15} />
          </button>
        )}
        <button
          type="button"
          className="rounded p-1 hover:bg-muted"
          title={t('pblV3.application.collapse')}
          aria-label={t('pblV3.application.collapse')}
          onClick={preview.close}
        >
          <ChevronRight size={15} />
        </button>
      </header>
      {!!application.choices?.length && (
        <div
          className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b bg-primary/5 px-3 py-2 text-xs"
          data-testid="pbl-application-choices"
        >
          {application.choices.map((choice) => (
            <p key={choice.id} title={choice.label}>
              <span className="text-muted-foreground">{t('pblV3.application.yourChoice')}：</span>{' '}
              <span className="font-medium">{choice.choice}</span>
            </p>
          ))}
        </div>
      )}
      {observation?.sourceChanged && (
        <p role="status" className="px-3 py-2 text-xs text-amber-600">
          {t('pblV3.application.changed')}
        </p>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {updating && (
        <p
          role="status"
          className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          <LoaderCircle size={14} className="shrink-0 animate-spin" />
          {t(
            standalone && !currentReady
              ? 'common.loading'
              : preview.dirty
                ? 'pblV3.application.saveFirst'
                : paused && disabled
                  ? 'pblV3.application.wait'
                  : 'pblV3.application.updating',
          )}
        </p>
      )}
      <div className="relative min-h-0 w-full flex-1">
        {mounted &&
          current &&
          [previous, current]
            .filter((item) => item !== null)
            .map((item) => {
              const visible = !previous || item === previous;
              return (
                <iframe
                  ref={(element) => {
                    if (visible) frame.current = element;
                    if (item === current) candidate.current = element;
                  }}
                  key={`${item.version}:${item.url}`}
                  title={visible ? application.title : t('pblV3.application.updating')}
                  src={(() => {
                    const target = new URL(item.url);
                    if (target.pathname === '/__openmaic_preview')
                      target.searchParams.set('openmaic-input', '1');
                    return target.href;
                  })()}
                  onLoad={(event) => {
                    sendInput(event.currentTarget);
                    // Real previews load an authorization shell first. Only its
                    // fenced readiness message can promote the nested app.
                    if (item === current && new URL(item.url).pathname !== '/__openmaic_preview') {
                      setDisplayed(item);
                      documentReady(item.version);
                    }
                  }}
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  hidden={expired}
                  inert={!inputAvailable || !visible}
                  aria-hidden={expired || !visible}
                  referrerPolicy="no-referrer"
                  className={`absolute inset-0 h-full w-full border-0 bg-white ${!inputAvailable || !visible ? 'pointer-events-none' : ''} ${visible && (item === previous || currentReady) ? '' : 'invisible'}`}
                />
              );
            })}
        {status}
      </div>
    </section>
  );
}
