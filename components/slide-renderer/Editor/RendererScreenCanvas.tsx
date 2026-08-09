'use client';

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAnimate } from 'motion/react';
import { SlideCanvas, type SlideEffects } from '@openmaic/renderer';
import type { PPTImageElement, PPTVideoElement } from '@openmaic/dsl';
import { Film, ImageOff, Paintbrush, RotateCcw, ShieldAlert, VideoOff } from 'lucide-react';
import { useCanvasStore } from '@/lib/store';
import { useSceneData, useSceneSelector } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import { useResolvedSlideMedia, type ResolvedSlideMediaEntry } from '../use-resolved-slide';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { mediaResolutionCanRetry, type MediaResolution } from '@/lib/media/resolve-media-ref';

const log = createLogger('RendererScreenCanvas');

function PlaybackVideoContent({
  element,
  media,
  sceneId,
  slideId,
}: {
  readonly element: PPTVideoElement;
  readonly media: ResolvedSlideMediaEntry | undefined;
  readonly sceneId: string;
  readonly slideId: string;
}) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingVideoElementId = useCanvasStore.use.playingVideoElementId();
  const prevPlayingRef = useRef('');
  const [scope, animate] = useAnimate<HTMLDivElement>();

  const task = media?.task;
  const mediaRef = media?.ref;
  const resolvedSrc = element.src || undefined;
  const resolvedPoster = element.poster || undefined;
  const showSkeleton =
    media?.resolution.kind === 'pending' || media?.resolution.kind === 'placeholder';
  const showDisabled = media?.resolution.kind === 'disabled';
  const showError = media?.resolution.kind === 'failed';
  const canRetry = mediaResolutionCanRetry(media?.resolution);

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

  if (showDisabled) {
    return (
      <div
        className="flex h-full w-full items-center justify-center rounded bg-gray-50 dark:bg-gray-900/20"
        data-media-state="disabled"
      >
        <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
          <VideoOff className="h-3 w-3 shrink-0" />
          <span>{t('settings.mediaGenerationDisabled')}</span>
        </div>
      </div>
    );
  }

  if (showError && media?.resolution.kind === 'failed') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded bg-red-50 dark:bg-red-900/20">
        {task?.errorCode === 'CONTENT_SENSITIVE' ? (
          <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 shrink-0" />
            <span>{t('settings.mediaContentSensitive')}</span>
          </div>
        ) : canRetry ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (mediaRef) {
                retryMediaTask(mediaRef, { elementId: element.id, sceneId, slideId });
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-200 dark:bg-red-900/40 dark:text-red-400 dark:hover:bg-red-900/60"
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.mediaRetry')}
          </button>
        ) : null}
      </div>
    );
  }

  if (resolvedSrc) {
    return (
      <div ref={scope} className="relative h-full w-full">
        <video
          ref={videoRef}
          className="h-full w-full"
          style={{ objectFit: 'contain' }}
          src={resolvedSrc}
          poster={resolvedPoster ?? undefined}
          preload="metadata"
          controls
          onEnded={handleEnded}
        />
        {canRetry ? (
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (mediaRef) {
                retryMediaTask(mediaRef, { elementId: element.id, sceneId, slideId });
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

export type PlaybackImageState = 'ready' | 'pending' | 'failed' | 'disabled';

export function getPlaybackImageState(resolution: MediaResolution): PlaybackImageState {
  if (resolution.kind === 'failed') return 'failed';
  if (resolution.kind === 'disabled') return 'disabled';
  if (resolution.kind === 'pending' || resolution.kind === 'placeholder') return 'pending';
  return 'ready';
}

function PlaybackImageContent({
  element,
  defaultContent,
  media,
  sceneId,
  slideId,
}: {
  readonly element: PPTImageElement;
  readonly defaultContent: ReactNode;
  readonly media: ResolvedSlideMediaEntry | undefined;
  readonly sceneId: string;
  readonly slideId: string;
}) {
  const { t } = useI18n();
  const task = media?.task;
  const state = getPlaybackImageState(media?.resolution ?? { kind: 'placeholder' });
  const canRetry = mediaResolutionCanRetry(media?.resolution);

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

  if (state === 'disabled') {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900/20"
        data-media-state="disabled"
      >
        <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
          <ImageOff className="h-3 w-3 shrink-0" />
          <span>{t('settings.mediaGenerationDisabled')}</span>
        </div>
      </div>
    );
  }

  if (state === 'failed' && media?.resolution.kind === 'failed') {
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
        ) : canRetry ? (
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (media?.ref) {
                retryMediaTask(media.ref, { elementId: element.id, sceneId, slideId });
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-200 dark:bg-red-900/40 dark:text-red-400 dark:hover:bg-red-900/60"
          >
            <RotateCcw className="h-3 w-3" />
            {t('settings.mediaRetry')}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {defaultContent}
      {canRetry ? (
        <button
          onClick={(event) => {
            event.stopPropagation();
            if (media?.ref) {
              retryMediaTask(media.ref, { elementId: element.id, sceneId, slideId });
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute right-1 top-1 flex items-center gap-1 rounded bg-red-100/95 px-2 py-1 text-[10px] font-medium text-red-600 shadow-sm dark:bg-red-900/80 dark:text-red-300"
        >
          <RotateCcw className="h-3 w-3" />
          {t('settings.mediaRetry')}
        </button>
      ) : null}
    </>
  );
}

export function RendererScreenCanvas() {
  const { sceneId } = useSceneData<SlideContent>();
  const slide = useSceneSelector<SlideContent, SlideContent['canvas']>((content) => content.canvas);
  const resolved = useResolvedSlideMedia(slide);

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
      slide={resolved.slide}
      canvasPercentage={canvasPercentage}
      onScaleChange={handleScaleChange}
      effects={effects}
      elementIdPrefix="screen-element-"
      renderImage={(element, _src, defaultContent) => (
        <PlaybackImageContent
          element={element}
          defaultContent={defaultContent}
          media={resolved.byElementId[element.id]}
          sceneId={sceneId}
          slideId={slide.id}
        />
      )}
      renderVideo={(element) => (
        <PlaybackVideoContent
          element={element}
          media={resolved.byElementId[element.id]}
          sceneId={sceneId}
          slideId={slide.id}
        />
      )}
      videoInteractive
      chrome
    />
  );
}
