'use client';
import { useEffect, useMemo, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useTheme } from '@/lib/hooks/use-theme';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { LearningReport } from '@/lib/pbl/v3/report';
import {
  reportShareContent,
  reportShareDestination,
  reportShareLayout,
} from '@/lib/pbl/v3/report-share';

const campaignArea = {
  left: `${(reportShareLayout.campaign.x / reportShareLayout.width) * 100}%`,
  top: `${(reportShareLayout.campaign.y / reportShareLayout.height) * 100}%`,
  width: `${(reportShareLayout.campaign.width / reportShareLayout.width) * 100}%`,
  height: `${(reportShareLayout.campaign.height / reportShareLayout.height) * 100}%`,
};
export function ReportShareDialog({
  report,
  onClose,
  onRestoreFocus,
}: {
  report: LearningReport;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const { t, locale } = useI18n();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme;
  const destination = reportShareDestination();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  const [failure, setFailure] = useState('');
  const serialized = JSON.stringify(reportShareContent(report));
  const content = useMemo(
    () => JSON.parse(serialized) as ReturnType<typeof reportShareContent>,
    [serialized],
  );
  const key = JSON.stringify([locale, report.studyId, serialized, theme, attempt]);
  const ready = result?.key === key ? result.url : null;
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void import('@/lib/pbl/v3/report-share-image')
      .then(({ renderReportShareImage }) => renderReportShareImage(content, theme, t, locale))
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
  }, [key, content, theme, t, locale]);
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
        showCloseButton={false}
        className="z-[150] block max-w-none rounded-xl bg-transparent p-0 ring-0"
        style={{ width: 'min(calc(100vw - 2rem), calc((100dvh - 3rem) * 0.8))' }}
        onEscapeKeyDown={(e) => e.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <div className="sr-only">
          <DialogTitle>{t('pblV3.share.title')}</DialogTitle>
          <DialogDescription>{t('pblV3.share.description')}</DialogDescription>
        </div>
        <div
          className="relative overflow-hidden rounded-xl bg-background shadow-2xl"
          aria-busy={!ready && failure !== key}
        >
          {ready ? (
            <img src={ready} alt={t('pblV3.share.preview')} className="block h-auto w-full" />
          ) : failure === key ? (
            <p role="alert" className="min-h-48 p-6 pr-14 text-sm">
              {t('pblV3.share.imageFailed')}
            </p>
          ) : (
            <p role="status" className="min-h-48 p-6 pr-14 text-sm">
              {t('pblV3.share.rendering')}
            </p>
          )}
          {ready && destination && (
            <a
              href={destination}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('pblV3.share.entryLabel')}
              title={destination}
              style={campaignArea}
              className="absolute rounded-xl transition-colors hover:bg-violet-400/10 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary"
            />
          )}
          {ready ? (
            <a
              href={ready}
              download={`OpenMAIC-${theme}.png`}
              aria-label={t('pblV3.share.save')}
              title={t('pblV3.share.save')}
              className="absolute right-1 bottom-1 z-10 flex size-7 items-center justify-center rounded-full border border-foreground/15 bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Download size={18} aria-hidden="true" />
            </a>
          ) : failure === key ? (
            <button
              className="m-6 mt-0 rounded-lg border px-3 py-2 text-sm"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t('pblV3.retry')}
            </button>
          ) : null}
          <DialogClose asChild>
            <button
              type="button"
              aria-label={t('common.close')}
              className="absolute top-3 right-3 z-10 flex size-9 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
