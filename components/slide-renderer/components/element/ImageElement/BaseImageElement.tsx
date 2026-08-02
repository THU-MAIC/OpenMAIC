'use client';

import type { PPTImageElement } from '@openmaic/dsl';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useClipImage } from './useClipImage';
import { useFilter } from './useFilter';
import { ImageOutline } from './ImageOutline';
import { useResolvedImageSrc } from './useResolvedImageSrc';
import { mediaRetryTarget, retryMediaTask } from '@/lib/media/media-orchestrator';
import { RotateCcw, Paintbrush, ShieldAlert, ImageOff } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSceneData } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import { mediaResolutionCanRetry } from '@/lib/media/resolve-media-ref';

export interface BaseImageElementProps {
  elementInfo: PPTImageElement;
}

/**
 * Base image element component for read-only display
 */
export function BaseImageElement({ elementInfo }: BaseImageElementProps) {
  const { t } = useI18n();
  const { sceneId, sceneData } = useSceneData<SlideContent>();
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { clipShape, imgPosition } = useClipImage(elementInfo);
  const { filter } = useFilter(elementInfo.filters);

  // Shared with the editor canvas's interactive ImageElement so both variants
  // resolve gen_img_* placeholders identically (Pro mode previously rendered
  // the raw placeholder string and showed a broken-image icon).
  const { resolvedSrc, task, resolution } = useResolvedImageSrc(elementInfo);
  const showSkeleton = resolution.kind === 'pending' || resolution.kind === 'placeholder';
  const showDisabled = resolution.kind === 'disabled';
  const showError = resolution.kind === 'failed';
  const canRetry = mediaResolutionCanRetry(resolution);

  return (
    <div
      className="element-content absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div className="w-full h-full" style={{ transform: `rotate(${elementInfo.rotate}deg)` }}>
        <div
          className="w-full h-full relative"
          style={{
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
          }}
        >
          <ImageOutline elementInfo={elementInfo} />

          <div
            className="w-full h-full overflow-hidden relative"
            style={{ clipPath: clipShape.style }}
          >
            {showSkeleton ? (
              <div className="w-full h-full bg-gradient-to-br from-amber-50 via-orange-50/60 to-yellow-50 dark:from-amber-950/40 dark:via-orange-950/30 dark:to-yellow-950/20 flex items-center justify-center">
                <style>{`
                  @keyframes img-pulse-ring { 0%, 100% { opacity: 0.15; transform: scale(0.85); } 50% { opacity: 0.35; transform: scale(1.1); } }
                `}</style>
                <div className="relative w-12 h-12">
                  <div
                    className="absolute inset-0 rounded-full border-2 border-amber-300/40 dark:border-amber-500/30"
                    style={{
                      animation: 'img-pulse-ring 2.4s ease-in-out infinite',
                    }}
                  />
                  <Paintbrush
                    className="absolute inset-0 m-auto w-5 h-5 text-amber-400/80 dark:text-amber-500/70"
                    strokeWidth={1.5}
                  />
                </div>
              </div>
            ) : showDisabled ? (
              <div
                className="w-full h-full bg-gray-50 dark:bg-gray-900/20 flex items-center justify-center"
                data-media-state="disabled"
              >
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                  <ImageOff className="w-3 h-3 shrink-0" />
                  <span>{t('settings.mediaGenerationDisabled')}</span>
                </div>
              </div>
            ) : showError ? (
              <div className="w-full h-full bg-red-50 dark:bg-red-900/20 flex flex-col items-center justify-center gap-1.5">
                {task?.errorCode === 'CONTENT_SENSITIVE' ? (
                  <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="w-3 h-3 shrink-0" />
                    <span>{t('settings.mediaContentSensitive')}</span>
                  </div>
                ) : canRetry ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      retryMediaTask(
                        elementInfo.src,
                        mediaRetryTarget(elementInfo.id, sceneId, sceneData),
                      );
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40 rounded hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('settings.mediaRetry')}
                  </button>
                ) : null}
              </div>
            ) : resolvedSrc ? (
              <>
                <img
                  src={resolvedSrc}
                  draggable={false}
                  style={{
                    position: 'absolute',
                    top: imgPosition.top,
                    left: imgPosition.left,
                    width: imgPosition.width,
                    height: imgPosition.height,
                    filter,
                  }}
                  alt=""
                  onDragStart={(e) => e.preventDefault()}
                />
                {elementInfo.colorMask && (
                  <div
                    className="absolute inset-0"
                    style={{ backgroundColor: elementInfo.colorMask }}
                  />
                )}
              </>
            ) : null}
            {canRetry && resolution.kind !== 'failed' ? (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  retryMediaTask(
                    elementInfo.src,
                    mediaRetryTarget(elementInfo.id, sceneId, sceneData),
                  );
                }}
                onPointerDown={(event) => event.stopPropagation()}
                className="absolute right-1 top-1 flex items-center gap-1 rounded bg-red-100/95 px-2 py-1 text-[10px] font-medium text-red-600 shadow-sm dark:bg-red-900/80 dark:text-red-300"
              >
                <RotateCcw className="h-3 w-3" />
                {t('settings.mediaRetry')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
