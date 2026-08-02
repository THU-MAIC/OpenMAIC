'use client';

import type { PPTVideoElement } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import {
  isConcreteMediaAddress,
  renderableMediaUrl,
  useResolvedMediaRef,
} from '@/lib/media/resolve-media-ref';
import { useSettingsStore } from '@/lib/store/settings';
import { VideoOff } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export interface VideoElementProps {
  elementInfo: PPTVideoElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTVideoElement) => void;
}

/**
 * Editable video element component.
 * In edit mode, displays the poster/thumbnail with a play icon overlay.
 * Does NOT autoplay to avoid disrupting the editing experience.
 */
export function VideoElement({ elementInfo, selectElement }: VideoElementProps) {
  const { t } = useI18n();
  const stageId = useMediaStageId();
  const mediaGenerationDisabled = useSettingsStore((state) => !state.videoGenerationEnabled);
  const mediaRef =
    getVideoMediaRefForElement(elementInfo) ??
    (elementInfo.src && !isConcreteMediaAddress(elementInfo.src) ? elementInfo.src : undefined);
  const task = useMediaGenerationStore((state) => {
    if (!stageId || !mediaRef) return undefined;
    const direct = state.tasks[mediaRef];
    if (direct?.stageId === stageId) return direct;
    return Object.values(state.tasks).find(
      (candidate) => candidate.stageId === stageId && candidate.placeholderRef === mediaRef,
    );
  });
  const resolution = useResolvedMediaRef(
    mediaRef ?? elementInfo.src,
    task,
    mediaGenerationDisabled,
  );
  const posterResolution = useResolvedMediaRef(
    elementInfo.poster,
    task?.poster ? { ...task, objectUrl: task.poster } : undefined,
  );
  const resolvedSrc = renderableMediaUrl(resolution);
  const resolvedPoster = renderableMediaUrl(posterResolution);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-video absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className={`element-content w-full h-full relative ${elementInfo.lock ? '' : 'cursor-move'}`}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          {resolution.kind === 'pending' || resolution.kind === 'placeholder' ? (
            <div className="w-full h-full animate-pulse rounded bg-black/10" />
          ) : resolution.kind === 'disabled' ? (
            <div
              className="flex h-full w-full items-center justify-center gap-1 rounded bg-gray-50 px-2 text-[10px] font-medium text-gray-500 dark:bg-gray-900/20 dark:text-gray-400"
              data-media-state="disabled"
            >
              <VideoOff className="h-3 w-3 shrink-0" />
              <span>{t('settings.mediaGenerationDisabled')}</span>
            </div>
          ) : resolution.kind === 'failed' ? (
            <div className="w-full h-full rounded bg-red-50 dark:bg-red-900/20" />
          ) : resolvedPoster ? (
            <img
              className="w-full h-full"
              style={{ objectFit: 'contain' }}
              src={resolvedPoster}
              alt=""
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            />
          ) : resolvedSrc ? (
            <video
              className="w-full h-full"
              style={{ objectFit: 'contain', pointerEvents: 'none' }}
              src={resolvedSrc}
              preload="metadata"
            />
          ) : (
            <div className="w-full h-full bg-black/10 rounded" />
          )}

          {/* Play icon overlay */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center">
              <svg className="w-6 h-6 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
