'use client';

import type { PPTVideoElement } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { mediaResolutionCanRetry } from '@/lib/media/resolve-media-ref';
import { useSettingsStore } from '@/lib/store/settings';
import { RotateCcw, VideoOff } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSceneData } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import { mediaRetryTarget, retryMediaTask } from '@/lib/media/media-orchestrator';
import { useResolvedVideoMedia } from './useResolvedVideoMedia';

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
  const { sceneId, sceneData } = useSceneData<SlideContent>();
  const stageId = useMediaStageId();
  const mediaGenerationDisabled = useSettingsStore((state) => !state.videoGenerationEnabled);
  const tasks = useMediaGenerationStore((state) => state.tasks);
  const { mediaRef, resolution, resolvedSrc, resolvedPoster } = useResolvedVideoMedia(
    elementInfo,
    tasks,
    stageId,
    mediaGenerationDisabled,
  );
  const canRetry = mediaResolutionCanRetry(resolution);
  const retryRef = mediaRef;

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
            <div className="flex h-full w-full items-center justify-center rounded bg-red-50 dark:bg-red-900/20">
              {canRetry && retryRef ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    retryMediaTask(retryRef, mediaRetryTarget(elementInfo.id, sceneId, sceneData));
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-[10px] font-medium text-red-600"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t('settings.mediaRetry')}
                </button>
              ) : null}
            </div>
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

          {canRetry && retryRef && resolution.kind !== 'failed' ? (
            <button
              onClick={(event) => {
                event.stopPropagation();
                retryMediaTask(retryRef, mediaRetryTarget(elementInfo.id, sceneId, sceneData));
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded bg-red-100/95 px-2 py-1 text-[10px] font-medium text-red-600 shadow-sm"
            >
              <RotateCcw className="h-3 w-3" />
              {t('settings.mediaRetry')}
            </button>
          ) : null}

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
