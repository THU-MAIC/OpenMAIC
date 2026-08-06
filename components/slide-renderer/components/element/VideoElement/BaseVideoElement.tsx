'use client';

import { useRef, useEffect } from 'react';
import { useAnimate } from 'motion/react';
import type { PPTVideoElement } from '@openmaic/dsl';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { mediaRetryTarget, retryMediaTask } from '@/lib/media/media-orchestrator';
import { mediaResolutionCanRetry } from '@/lib/media/resolve-media-ref';
import { RotateCcw, Film, ShieldAlert, VideoOff } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { useSettingsStore } from '@/lib/store/settings';
import { useSceneData } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import { useResolvedVideoMedia } from './useResolvedVideoMedia';

const log = createLogger('BaseVideoElement');

export interface BaseVideoElementProps {
  elementInfo: PPTVideoElement;
}

/**
 * Base video element component for read-only/presentation display.
 * Controlled exclusively by the canvas store via the play_video action.
 * Videos never autoplay — they wait for an explicit play_video action.
 */
export function BaseVideoElement({ elementInfo }: BaseVideoElementProps) {
  const { t } = useI18n();
  const { sceneId, sceneData } = useSceneData<SlideContent>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingVideoElementId = useCanvasStore.use.playingVideoElementId();
  const prevPlayingRef = useRef('');
  const [scope, animate] = useAnimate<HTMLDivElement>();

  // Only subscribe to media store when inside a classroom (stageId provided via context).
  const stageId = useMediaStageId();
  const mediaGenerationDisabled = useSettingsStore((state) => !state.videoGenerationEnabled);
  const tasks = useMediaGenerationStore((state) => state.tasks);
  const { mediaRef, task, resolution, resolvedSrc, resolvedPoster } = useResolvedVideoMedia(
    elementInfo,
    tasks,
    stageId,
    mediaGenerationDisabled,
  );
  const showSkeleton = resolution.kind === 'pending' || resolution.kind === 'placeholder';
  const showDisabled = resolution.kind === 'disabled';
  const showError = resolution.kind === 'failed';
  const canRetry = mediaResolutionCanRetry(resolution);
  const isReady = !!resolvedSrc;

  // Ensure video is paused on mount — prevents browser autoplay from user gesture context
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isMe = playingVideoElementId === elementInfo.id;
    const wasMe = prevPlayingRef.current === elementInfo.id;
    prevPlayingRef.current = playingVideoElementId;

    if (isMe && !wasMe) {
      // "Tap" press animation — a deliberate, teacher-paced click feel
      animate(
        scope.current,
        { scale: [1, 1.035, 1] },
        {
          duration: 0.6,
          ease: [0.25, 0.1, 0.25, 1],
          times: [0, 0.35, 1],
        },
      );
      video.play().catch((err) => {
        log.warn('[BaseVideoElement] play() failed:', err);
      });
    } else if (!isMe && wasMe) {
      video.pause();
    }
  }, [playingVideoElementId, elementInfo.id, animate, scope]);

  const handleEnded = () => {
    if (useCanvasStore.getState().playingVideoElementId === elementInfo.id) {
      useCanvasStore.getState().pauseVideo();
    }
  };

  return (
    <div
      className="element-content absolute"
      data-video-element
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        ref={scope}
        className="relative w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        {showSkeleton ? (
          <div className="w-full h-full bg-gradient-to-br from-indigo-50 via-violet-50/60 to-blue-50 dark:from-indigo-950/40 dark:via-violet-950/30 dark:to-blue-950/20 flex items-center justify-center rounded">
            <style>{`
              @keyframes vid-pulse-ring { 0%, 100% { opacity: 0.15; transform: scale(0.85); } 50% { opacity: 0.35; transform: scale(1.1); } }
            `}</style>
            <div className="relative w-14 h-14">
              <div
                className="absolute inset-0 rounded-full border-2 border-indigo-300/40 dark:border-indigo-500/30"
                style={{
                  animation: 'vid-pulse-ring 2.4s ease-in-out infinite',
                }}
              />
              <Film
                className="absolute inset-0 m-auto w-5 h-5 text-indigo-400/80 dark:text-indigo-500/70"
                strokeWidth={1.5}
              />
            </div>
          </div>
        ) : showDisabled ? (
          <div
            className="w-full h-full bg-gray-50 dark:bg-gray-900/20 flex items-center justify-center rounded"
            data-media-state="disabled"
          >
            <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
              <VideoOff className="w-3 h-3 shrink-0" />
              <span>{t('settings.mediaGenerationDisabled')}</span>
            </div>
          </div>
        ) : showError ? (
          <div className="w-full h-full bg-red-50 dark:bg-red-900/20 flex flex-col items-center justify-center gap-1.5 rounded">
            {task?.errorCode === 'CONTENT_SENSITIVE' ? (
              <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <ShieldAlert className="w-3 h-3 shrink-0" />
                <span>{t('settings.mediaContentSensitive')}</span>
              </div>
            ) : canRetry ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (mediaRef) {
                    retryMediaTask(mediaRef, mediaRetryTarget(elementInfo.id, sceneId, sceneData));
                  }
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40 rounded hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                {t('settings.mediaRetry')}
              </button>
            ) : null}
          </div>
        ) : isReady && resolvedSrc ? (
          <video
            ref={videoRef}
            className="w-full h-full"
            style={{ objectFit: 'contain' }}
            src={resolvedSrc}
            poster={resolvedPoster ?? undefined}
            preload="metadata"
            controls
            onEnded={handleEnded}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-black/10 rounded">
            <svg
              className="w-12 h-12 text-gray-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        )}
        {canRetry && resolution.kind !== 'failed' ? (
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (mediaRef) {
                retryMediaTask(mediaRef, mediaRetryTarget(elementInfo.id, sceneId, sceneData));
              }
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
  );
}
