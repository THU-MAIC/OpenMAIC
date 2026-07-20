'use client';

/**
 * Video-export section of the header export menu.
 *
 * Two paths sharing the same project ZIP:
 * - **Render MP4** (when the render service is configured) — uploads the ZIP to
 *   the service, polls the async job, downloads the finished MP4. Exposes
 *   resolution / fps / quality selectors and a live progress bar.
 * - **Download ZIP** — the always-available degrade path: saves the
 *   self-contained project for local CLI rendering.
 *
 * Capability is probed on mount (`/api/export-video/capability`) so the MP4
 * action only appears when it will actually work; otherwise only the ZIP
 * download shows, with a short hint.
 */
import { useEffect, useState } from 'react';
import { Film, Loader2 } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { useExportVideo } from '@/lib/video-export-app/use-export-video';
import { useRenderVideo } from '@/lib/video-export-app/use-render-video';
import {
  VIDEO_FPS,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  type VideoResolution,
} from '@/lib/video-export-app/build-export-zip';

const RESOLUTIONS = Object.keys(VIDEO_RESOLUTIONS) as VideoResolution[];

/**
 * Format an ETA (ms) as a short localized "about X min Y sec" / "about Y sec"
 * string. Rounds seconds up so it never shows "0 sec" while still working.
 */
function formatRemaining(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? t('export.videoEtaMinSec', { min, sec }) : t('export.videoEtaSec', { sec });
}

/** A row of mutually-exclusive small pill buttons. */
function OptionRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format?: (v: T) => string;
  disabled?: boolean;
}) {
  return (
    <div className="px-4 pb-2">
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      <div className="flex gap-1.5">
        {options.map((opt) => (
          <button
            key={String(opt)}
            onClick={() => onChange(opt)}
            disabled={disabled}
            className={cn(
              'flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50',
              opt === value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700',
            )}
          >
            {format ? format(opt) : String(opt)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function VideoExportMenu({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { exporting: isExportingVideo, exportVideo } = useExportVideo();
  const { rendering, percent, etaMs, options, setOptions, renderVideo } = useRenderVideo();
  const { resolution, fps, quality } = options;
  // undefined = unknown (still probing); true/false = capability answer.
  const [serviceEnabled, setServiceEnabled] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetch('/api/export-video/capability')
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => {
        if (active) setServiceEnabled(Boolean(d.enabled));
      })
      .catch(() => {
        if (active) setServiceEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const busy = isExportingVideo || rendering;

  return (
    <>
      <div className="border-t border-gray-200 dark:border-gray-700" />
      <div className="px-4 pt-2.5 pb-1 flex items-center gap-2.5 text-sm">
        <Film className="w-4 h-4 text-gray-400 shrink-0" />
        <div>
          <div>{t('export.video')}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('export.videoDesc')}
          </div>
        </div>
      </div>

      <OptionRow
        label={t('export.videoResolution')}
        options={RESOLUTIONS}
        value={resolution}
        onChange={(resolution) => setOptions({ resolution })}
        format={(r) => (r === '4k' ? '4K' : r)}
        disabled={busy}
      />

      {/* fps + quality only matter for MP4 rendering. */}
      {serviceEnabled && (
        <>
          <OptionRow
            label={t('export.videoFps')}
            options={VIDEO_FPS}
            value={fps}
            onChange={(fps) => setOptions({ fps })}
            disabled={busy}
          />
          <OptionRow
            label={t('export.videoQuality')}
            options={VIDEO_QUALITIES}
            value={quality}
            onChange={(quality) => setOptions({ quality })}
            format={(q) => t(`export.videoQuality_${q}`)}
            disabled={busy}
          />
        </>
      )}

      {rendering && (
        <div className="px-4 pb-2">
          <Progress value={percent} />
          <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            {etaMs != null
              ? t('export.videoProgressWithEta', {
                  percent,
                  remaining: formatRemaining(etaMs, t),
                })
              : t('export.videoProgress', { percent })}
          </div>
        </div>
      )}

      <div className="px-4 pb-2.5 flex flex-col gap-1.5">
        {serviceEnabled && (
          <button
            onClick={() => renderVideo()}
            disabled={busy}
            className="w-full px-2 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {rendering && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('export.videoRenderMp4')}
          </button>
        )}
        <button
          onClick={() => {
            exportVideo(resolution);
            onClose();
          }}
          disabled={busy}
          className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {isExportingVideo && <Loader2 className="w-3 h-3 animate-spin" />}
          {t('export.videoDownloadZip')}
        </button>
        {serviceEnabled === false && (
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {t('export.videoServiceHint')}
          </div>
        )}
      </div>
    </>
  );
}
