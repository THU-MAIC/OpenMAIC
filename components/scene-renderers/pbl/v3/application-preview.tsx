'use client';
import { useEffect, useRef, useState } from 'react';
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
  return (
    <ApplicationPreviewContent
      key={preview.documentScope}
      application={application}
      preview={preview}
    />
  );
}

function ApplicationPreviewContent({
  application,
  preview,
}: {
  application: NonNullable<LearningView['application']>;
  preview: ApplicationPreviewController;
}) {
  const { t } = useI18n();
  const { pending, observation, error, expired, disabled } = preview;
  const mounted = !!observation?.preview;
  const frame = useRef<HTMLIFrameElement | null>(null);
  const url = observation?.preview?.url;
  const [displayed, setDisplayed] = useState<{ url: string; version: number } | null>(null);
  const current = url ? { url, version: preview.frameVersion } : null;
  const previous =
    displayed && current && (displayed.url !== current.url || displayed.version !== current.version)
      ? displayed
      : null;
  const available =
    !disabled &&
    mounted &&
    !expired &&
    !preview.updating &&
    !error &&
    observation?.state === 'running' &&
    !previous;
  const updating = mounted && !expired && !error && (preview.updating || !!previous);
  const renew = preview.renew;
  useEffect(() => {
    if (!url) return;
    const origin = new URL(previous?.url ?? url).origin;
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
  }, [url, previous?.url, renew]);
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
          {t(preview.dirty ? 'pblV3.application.saveFirst' : 'pblV3.application.updating')}
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
                  ref={visible ? frame : undefined}
                  key={`${item.version}:${item.url}`}
                  title={visible ? application.title : t('pblV3.application.updating')}
                  src={item.url}
                  onLoad={() => {
                    if (item === current) setDisplayed(item);
                  }}
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  hidden={expired}
                  inert={!available || !visible}
                  aria-hidden={expired || !visible}
                  referrerPolicy="no-referrer"
                  className={`absolute inset-0 h-full w-full border-0 bg-white ${!available || !visible ? 'pointer-events-none' : ''} ${visible ? '' : 'opacity-0'}`}
                />
              );
            })}
        {!available && !updating && (
          <div
            role="status"
            className={
              mounted && !expired
                ? 'absolute left-3 right-3 top-3 z-10 flex max-h-full flex-wrap items-center justify-center gap-2 overflow-auto rounded-lg border bg-background/95 p-3 text-center text-sm text-muted-foreground shadow-sm'
                : 'flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center text-sm text-muted-foreground'
            }
          >
            {(pending || preview.updating || !!previous) && (
              <LoaderCircle size={16} className="shrink-0 animate-spin" />
            )}
            <p>
              {t(
                mounted && !expired && !error && (preview.updating || previous)
                  ? preview.dirty
                    ? 'pblV3.application.saveFirst'
                    : 'pblV3.application.updating'
                  : disabled
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
      </div>
    </section>
  );
}
