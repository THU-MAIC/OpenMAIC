'use client';

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAnimate } from 'motion/react';
import { SlideCanvas, type SlideEffects } from '@openmaic/renderer';
import type { PPTImageElement, PPTVideoElement } from '@openmaic/dsl';
import { Film, ImageOff, Paintbrush, RotateCcw, ShieldAlert, VideoOff } from 'lucide-react';
import { useCanvasStore } from '@/lib/store';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import { useResolvedSlide } from '../use-resolved-slide';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import {
  isMediaPlaceholder,
  type MediaTask,
  useMediaGenerationStore,
} from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

const log = createLogger('RendererScreenCanvas');

function isLegacySequentialVideoRef(value: string | undefined): boolean {
  return !!value && /^gen_vid_\d+$/i.test(value);
}

function PlaybackVideoContent({ element }: { readonly element: PPTVideoElement }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingVideoElementId = useCanvasStore.use.playingVideoElementId();
  const prevPlayingRef = useRef('');
  const [scope, animate] = useAnimate<HTMLDivElement>();

  const stageId = useMediaStageId();
  const mediaRef = getVideoMediaRefForElement(element);
  const concreteSrc = element.src && !isMediaPlaceholder(element.src) ? element.src : undefined;
  const isPlaceholder = !!mediaRef;
  const task = useMediaGenerationStore((s) => {
    if (!mediaRef) return undefined;
    const candidate = s.tasks[mediaRef];
    if (candidate && candidate.stageId !== stageId) return undefined;
    if (candidate) return candidate;

    const sameStageVideoTasks = Object.values(s.tasks).filter(
      (item) => item.type === 'video' && item.stageId === stageId && item.status === 'done',
    );
    if (isLegacySequentialVideoRef(mediaRef) && sameStageVideoTasks.length === 1) {
      return sameStageVideoTasks[0];
    }

    return undefined;
  });
  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled);
  const resolvedSrc = task?.status === 'done' && task.objectUrl ? task.objectUrl : concreteSrc;
  const showDisabled = isPlaceholder && !concreteSrc && !task && !videoGenerationEnabled;
  const showSkeleton =
    isPlaceholder &&
    !concreteSrc &&
    !showDisabled &&
    (!task || task.status === 'pending' || task.status === 'generating');
  const showError = isPlaceholder && !concreteSrc && task?.status === 'failed';

  useEffect(() => {
    videoRef.current?.pause();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isMe = playingVideoElementId === element.id;
    const wasMe = prevPlayingRef.current === element.id;
    prevPlayingRef.current = playingVideoElementId;

    if (isMe && !wasMe) {
      animate(
        scope.current,
        { scale: [1, 1.035, 1] },
        { duration: 0.6, ease: [0.25, 0.1, 0.25, 1], times: [0, 0.35, 1] },
      );
      video.play().catch((err) => {
        log.warn('[PlaybackVideoContent] play() failed:', err);
      });
    } else if (!isMe && wasMe) {
      video.pause();
    }
  }, [playingVideoElementId, element.id, animate, scope]);

  const handleEnded = () => {
    if (useCanvasStore.getState().playingVideoElementId === element.id) {
      useCanvasStore.getState().pauseVideo();
    }
  };

  if (showDisabled) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded bg-gray-50 dark:bg-gray-900/30">
        <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
          <VideoOff className="h-3 w-3 shrink-0" />
          <span>{t('settings.mediaGenerationDisabled')}</span>
        </div>
      </div>
    );
  }

  if (showSkeleton) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded bg-gradient-to-br from-indigo-50 via-violet-50/60 to-blue-50 dark:from-indigo-950/40 dark:via-violet-950/30 dark:to-blue-950/20">
        <div className="relative h-14 w-14">
          <div className="absolute inset-0 animate-pulse rounded-full border-2 border-indigo-300/40 dark:border-indigo-500/30" />
          <Film
            className="absolute inset-0 m-auto h-5 w-5 text-indigo-400/80 dark:text-indigo-500/70"
            strokeWidth={1.5}
          />
        </div>
      </div>
    );
  }

  if (showError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded bg-red-50 dark:bg-red-900/20">
        {task?.errorCode === 'CONTENT_SENSITIVE' ? (
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 shrink-0" />
            <span>{t('settings.mediaContentSensitive')}</span>
          </div>
        ) : task?.errorCode === 'GENERATION_DISABLED' ? (
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
            <VideoOff className="h-3 w-3 shrink-0" />
            <span>{t('settings.mediaGenerationDisabled')}</span>
          </div>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (mediaRef) retryMediaTask(mediaRef);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-200 dark:bg-red-900/40 dark:text-red-400 dark:hover:bg-red-900/60"
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.mediaRetry')}
          </button>
        )}
      </div>
    );
  }

  if (resolvedSrc) {
    return (
      <div ref={scope} className="h-full w-full">
        <video
          ref={videoRef}
          className="h-full w-full"
          style={{ objectFit: 'contain' }}
          src={resolvedSrc}
          poster={task?.poster || element.poster}
          preload="metadata"
          controls
          onEnded={handleEnded}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center rounded bg-black/10">
      <svg
        className="h-12 w-12 text-gray-400"
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
  );
}

function renderPlaybackVideo(element: PPTVideoElement) {
  return <PlaybackVideoContent element={element} />;
}

export type PlaybackImageState = 'ready' | 'pending' | 'failed' | 'disabled';

export function getPlaybackImageState(
  isPlaceholder: boolean,
  task: MediaTask | undefined,
  imageGenerationEnabled: boolean,
): PlaybackImageState {
  if (!isPlaceholder) return 'ready';
  if (!task && !imageGenerationEnabled) return 'disabled';
  if (!task || task.status === 'pending' || task.status === 'generating') return 'pending';
  if (task.status === 'failed') return 'failed';
  return 'ready';
}

function PlaybackImageContent({
  element,
  defaultContent,
}: {
  readonly element: PPTImageElement;
  readonly defaultContent: ReactNode;
}) {
  const { t } = useI18n();
  const stageId = useMediaStageId();
  const isPlaceholder = !!stageId && !!element.src && isMediaPlaceholder(element.src);
  const task = useMediaGenerationStore((s) => {
    if (!isPlaceholder) return undefined;
    const candidate = s.tasks[element.src];
    return candidate?.stageId === stageId ? candidate : undefined;
  });
  const imageGenerationEnabled = useSettingsStore((s) => s.imageGenerationEnabled);
  const state = getPlaybackImageState(isPlaceholder, task, imageGenerationEnabled);

  if (state === 'disabled') {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900/30"
        data-media-state="disabled"
      >
        <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
          <ImageOff className="h-3 w-3 shrink-0" />
          <span>{t('settings.mediaGenerationDisabled')}</span>
        </div>
      </div>
    );
  }

  if (state === 'pending') {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-gradient-to-br from-amber-50 via-orange-50/60 to-yellow-50 dark:from-amber-950/40 dark:via-orange-950/30 dark:to-yellow-950/20"
        data-media-state="pending"
      >
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 animate-pulse rounded-full border-2 border-amber-300/40 dark:border-amber-500/30" />
          <Paintbrush
            className="absolute inset-0 m-auto h-5 w-5 text-amber-400/80 dark:text-amber-500/70"
            strokeWidth={1.5}
          />
        </div>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-red-50 dark:bg-red-900/20"
        data-media-state="failed"
      >
        {task?.errorCode === 'CONTENT_SENSITIVE' ? (
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 shrink-0" />
            <span>{t('settings.mediaContentSensitive')}</span>
          </div>
        ) : task?.errorCode === 'GENERATION_DISABLED' ? (
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
            <ImageOff className="h-3 w-3 shrink-0" />
            <span>{t('settings.mediaGenerationDisabled')}</span>
          </div>
        ) : (
          <button
            onClick={(event) => {
              event.stopPropagation();
              retryMediaTask(element.src);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-200 dark:bg-red-900/40 dark:text-red-400 dark:hover:bg-red-900/60"
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.mediaRetry')}
          </button>
        )}
      </div>
    );
  }

  return defaultContent;
}

function renderPlaybackImage(
  element: PPTImageElement,
  _resolvedSrc: string,
  defaultContent: ReactNode,
) {
  return <PlaybackImageContent element={element} defaultContent={defaultContent} />;
}

export function RendererScreenCanvas() {
  const slide = useSceneSelector<SlideContent, SlideContent['canvas']>((content) => content.canvas);
  const resolvedSlide = useResolvedSlide(slide, {
    preserveUnresolvedImagePlaceholders: true,
  });

  const canvasPercentage = useCanvasStore.use.canvasPercentage();
  const setCanvasScale = useCanvasStore.use.setCanvasScale();

  const highlightedElementIds = useCanvasStore.use.highlightedElementIds();
  const highlightOptions = useCanvasStore.use.highlightOptions();
  const spotlightElementId = useCanvasStore.use.spotlightElementId();
  const spotlightOptions = useCanvasStore.use.spotlightOptions();
  const laserElementId = useCanvasStore.use.laserElementId();
  const laserOptions = useCanvasStore.use.laserOptions();
  const zoomTarget = useCanvasStore.use.zoomTarget();

  const handleScaleChange = useCallback(
    (scale: number) => {
      setCanvasScale(scale);
    },
    [setCanvasScale],
  );

  const effects = useMemo<SlideEffects>(() => {
    const next: SlideEffects = {};
    if (highlightOptions && highlightedElementIds.length) {
      next.highlights = highlightedElementIds.map((elementId) => ({
        elementId,
        ...highlightOptions,
      }));
    }
    if (spotlightElementId && spotlightOptions) {
      next.spotlight = {
        elementId: spotlightElementId,
        dimness: spotlightOptions.dimness,
      };
    }
    if (laserElementId && laserOptions) {
      next.laser = {
        elementId: laserElementId,
        color: laserOptions.color,
        duration: laserOptions.duration,
      };
    }
    if (zoomTarget) {
      next.zoom = zoomTarget;
    }
    return next;
  }, [
    highlightOptions,
    highlightedElementIds,
    laserElementId,
    laserOptions,
    spotlightElementId,
    spotlightOptions,
    zoomTarget,
  ]);

  return (
    <SlideCanvas
      slide={resolvedSlide}
      canvasPercentage={canvasPercentage}
      onScaleChange={handleScaleChange}
      effects={effects}
      elementIdPrefix="screen-element-"
      renderImage={renderPlaybackImage}
      renderVideo={renderPlaybackVideo}
      videoInteractive
      chrome
    />
  );
}
