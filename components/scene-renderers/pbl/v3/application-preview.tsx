'use client';
import { useEffect, useRef } from 'react';
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
}: {
  application: NonNullable<LearningView['application']>;
  preview: ApplicationPreviewController;
}) {
  const { t } = useI18n();
  const { pending, observation, error, expired, disabled } = preview;
  const available = !disabled && observation?.preview && !expired;
  const mounted = !disabled && observation?.preview;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const url = observation?.preview?.url;
  const renew = preview.renew;
  useEffect(() => {
    if (!url || disabled) return;
    const origin = new URL(url).origin;
    const receive = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === origin &&
        event.data?.type === 'openmaic-preview-activity'
      )
        renew(event.data.expiresAt);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [url, disabled, renew]);
  return (
    <section
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
          </div>
        </details>
        <button
          type="button"
          disabled={pending || disabled}
          className="rounded p-1 hover:bg-muted disabled:opacity-40"
          title={t('pblV3.application.restart')}
          aria-label={t('pblV3.application.restart')}
          onClick={() => void preview.load('restart')}
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
      {mounted && (
        <iframe
          ref={frame}
          key={observation.preview!.url}
          title={application.title}
          src={observation.preview!.url}
          sandbox="allow-scripts allow-forms allow-same-origin"
          hidden={expired}
          inert={expired}
          aria-hidden={expired}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
      {!available && (
        <div
          role="status"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center text-sm text-muted-foreground"
        >
          {pending && <LoaderCircle className="animate-spin" />}
          <p>
            {t(
              disabled
                ? preview.dirty
                  ? 'pblV3.application.saveFirst'
                  : 'pblV3.application.wait'
                : pending
                  ? 'pblV3.application.starting'
                  : expired
                    ? 'pblV3.application.expired'
                    : observation?.state === 'failed'
                      ? 'pblV3.application.failed'
                      : observation
                        ? 'pblV3.application.unavailable'
                        : 'pblV3.application.ready',
            )}
          </p>
          {observation?.output && (
            <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap text-left text-xs">
              {observation.output}
            </pre>
          )}
          {!pending && !disabled && (
            <button
              type="button"
              className="rounded border px-3 py-2 text-foreground"
              onClick={() => void preview.load('open')}
            >
              {t('pblV3.application.reopen')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
