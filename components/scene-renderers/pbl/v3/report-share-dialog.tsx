'use client';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { LearningReport } from '@/lib/pbl/v3/report';
import {
  reportShareContent,
  type ShareOrientation,
  type ShareTheme,
} from '@/lib/pbl/v3/report-share';
export function ReportShareDialog({
  report,
  onClose,
}: {
  report: LearningReport;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { resolvedTheme } = useTheme();
  const [orientation, setOrientation] = useState<ShareOrientation>(() =>
    window.innerWidth < 640 ? 'portrait' : 'landscape',
  );
  const [theme, setTheme] = useState<ShareTheme>(resolvedTheme === 'dark' ? 'dark' : 'light');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  const [failure, setFailure] = useState('');
  const serialized = JSON.stringify(reportShareContent(report));
  const content = useMemo(
    () => JSON.parse(serialized) as ReturnType<typeof reportShareContent>,
    [serialized],
  );
  const key = JSON.stringify([
    locale,
    report.studyId,
    report.revision,
    serialized,
    orientation,
    theme,
    attempt,
  ]);
  const ready = result?.key === key ? result.url : null;
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void import('@/lib/pbl/v3/report-share-image')
      .then(({ renderReportShareImage }) => renderReportShareImage(content, orientation, theme, t))
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setResult({ key, url });
      })
      .catch(() => {
        if (active) setFailure(key);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, content, orientation, theme, t]);
  const optionClass =
    'rounded-lg border px-3 py-2 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        container={document.fullscreenElement as HTMLElement | null}
        overlayClassName="z-[140]"
        className="z-[150] flex max-h-[94dvh] max-w-[calc(100vw-1rem)] flex-col gap-4 overflow-y-auto sm:max-w-4xl"
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{t('pblV3.share.title')}</DialogTitle>
          <DialogDescription>{t('pblV3.share.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-3">
          <div role="group" aria-label={t('pblV3.share.orientation')} className="flex gap-1">
            {(['landscape', 'portrait'] as const).map((value) => (
              <button
                key={value}
                className={optionClass}
                aria-pressed={orientation === value}
                onClick={() => setOrientation(value)}
              >
                {t(`pblV3.share.${value}`)}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t('pblV3.share.theme')} className="flex gap-1">
            {(['light', 'dark'] as const).map((value) => (
              <button
                key={value}
                className={optionClass}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {t(`pblV3.share.${value}`)}
              </button>
            ))}
          </div>
        </div>
        <div
          className="flex min-h-32 justify-center rounded-xl bg-muted/40 p-2"
          aria-busy={!ready && failure !== key}
        >
          {ready ? (
            <img
              src={ready}
              alt={t('pblV3.share.preview')}
              className="h-auto w-full max-w-full self-start rounded-lg"
            />
          ) : failure === key ? (
            <p role="alert" className="p-6 text-sm">
              {t('pblV3.share.imageFailed')}
            </p>
          ) : (
            <p role="status" className="p-6 text-sm">
              {t('pblV3.share.rendering')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {ready ? (
            <a
              href={ready}
              download={`OpenMAIC-${orientation}-${theme}.png`}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              {t('pblV3.share.save')}
            </a>
          ) : failure === key ? (
            <button className={optionClass} onClick={() => setAttempt((n) => n + 1)}>
              {t('pblV3.retry')}
            </button>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('pblV3.share.saveHint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
