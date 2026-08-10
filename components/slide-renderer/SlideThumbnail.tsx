'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import type { Slide, PPTImageElement, PPTVideoElement } from '@openmaic/dsl';
import { SlideCanvas } from '@openmaic/renderer';
import { useResolvedSlideMedia, type ResolvedSlideMediaEntry } from './use-resolved-slide';
import { useI18n } from '@/lib/hooks/use-i18n';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { mediaResolutionCanRetry } from '@/lib/media/resolve-media-ref';

interface SlideThumbnailProps {
  /** Slide data */
  readonly slide: Slide;
  /**
   * Thumbnail width in px. When omitted, the thumbnail fills its parent
   * (`w-full h-full`) — use auto-size in any container that already constrains
   * width via CSS (e.g. `aspect-video w-full`).
   */
  readonly size?: number;
  /** Viewport width base (default 1000px). Kept for call-site API parity with
   * the legacy `ThumbnailSlide`; the actual fit is driven by `slide.viewportSize`. */
  readonly viewportSize?: number;
  /** Viewport aspect ratio (default 0.5625 i.e. 16:9). Used to size the explicit box. */
  readonly viewportRatio: number;
  /** Whether visible (for lazy loading optimization) */
  readonly visible?: boolean;
  /** Owning scene used to scope a shared-ref retry. */
  readonly sceneId?: string;
}

/**
 * Read-only thumbnail rendering for a video element. Replaces `@openmaic/renderer`'s
 * default `<video controls>` with a muted, play-badged treatment suited to
 * thumbnails. `BaseVideoElement` already supplies the absolutely-positioned,
 * rotated wrapper, so this only paints the inner content. The `src` it receives
 * is already media-store-resolved by `useResolvedSlide`.
 *
 * The play-badge (`thumbnail-video-indicator`) always shows; the `<video>` only
 * renders for a real (resolved, non-placeholder) src so unresolved media falls
 * through to the badge-only frame instead of an empty `<video>`.
 */
function renderThumbnailVideo(
  element: PPTVideoElement,
  media: ResolvedSlideMediaEntry | undefined,
  disabledMessage: string,
  retryLabel: string,
  onRetry: () => void,
) {
  const nonRenderable =
    media?.resolution.kind === 'pending' || media?.resolution.kind === 'placeholder';
  const failed = media?.resolution.kind === 'failed';
  const disabled = media?.resolution.kind === 'disabled';
  const src = nonRenderable || failed || disabled ? undefined : element.src;
  return (
    <>
      {nonRenderable ? (
        <div
          className="h-full w-full animate-pulse rounded bg-black/10"
          data-media-state="pending"
        />
      ) : disabled ? (
        <div
          className="flex h-full w-full items-center justify-center rounded bg-gray-50 px-2 text-center text-[10px] font-medium text-gray-500"
          data-media-state="disabled"
        >
          {disabledMessage}
        </div>
      ) : failed ? (
        <div className="h-full w-full rounded bg-red-50" data-media-state="failed" />
      ) : src ? (
        <video
          className="w-full h-full"
          style={{ objectFit: 'contain' }}
          src={src}
          poster={element.poster}
          preload="metadata"
          muted
          playsInline
        />
      ) : (
        <div className="w-full h-full bg-black/10 rounded" />
      )}
      {mediaResolutionCanRetry(media?.resolution) ? (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="pointer-events-auto absolute right-1 top-1 z-10 flex items-center gap-1 rounded bg-red-100/95 px-2 py-1 text-[10px] font-medium text-red-600 shadow-sm"
        >
          <RotateCcw className="h-3 w-3" />
          {retryLabel}
        </button>
      ) : null}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        data-testid="thumbnail-video-indicator"
      >
        <div className="flex size-28 items-center justify-center rounded-full bg-black/45 shadow-lg ring-2 ring-white/85">
          <Play className="ml-1 size-14 fill-white text-white" />
        </div>
      </div>
    </>
  );
}

function renderThumbnailImage(
  _element: PPTImageElement,
  _src: string,
  defaultContent: ReactNode,
  media: ResolvedSlideMediaEntry | undefined,
  disabledMessage: string,
  retryLabel: string,
  onRetry: () => void,
) {
  if (media?.resolution.kind === 'pending' || media?.resolution.kind === 'placeholder') {
    return <div className="h-full w-full animate-pulse bg-black/10" data-media-state="pending" />;
  }
  if (media?.resolution.kind === 'failed') {
    return (
      <div className="relative h-full w-full bg-red-50" data-media-state="failed">
        {mediaResolutionCanRetry(media.resolution) ? (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="pointer-events-auto absolute right-1 top-1 z-10 flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-[10px] font-medium text-red-600 shadow-sm"
          >
            <RotateCcw className="h-3 w-3" />
            {retryLabel}
          </button>
        ) : null}
      </div>
    );
  }
  if (media?.resolution.kind === 'disabled') {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-gray-50 px-2 text-center text-[10px] font-medium text-gray-500"
        data-media-state="disabled"
      >
        {disabledMessage}
      </div>
    );
  }
  return (
    <>
      {defaultContent}
      {mediaResolutionCanRetry(media?.resolution) ? (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="pointer-events-auto absolute right-1 top-1 z-10 flex items-center gap-1 rounded bg-red-100/95 px-2 py-1 text-[10px] font-medium text-red-600 shadow-sm"
        >
          <RotateCcw className="h-3 w-3" />
          {retryLabel}
        </button>
      ) : null}
    </>
  );
}

/**
 * Read-only slide thumbnail rendered via the extracted `@openmaic/renderer`
 * package (`SlideCanvas`) instead of the in-app `ThumbnailSlide`/element
 * renderers. `SlideCanvas` fills its parent and auto-fits the slide, so this
 * wrapper owns the outer box sizing (explicit `size` vs parent-filling), the
 * lazy-load placeholder, the thumbnail video treatment (via the renderer's
 * `renderVideo` slot), and the media-store resolution (via `useResolvedSlide`,
 * so generated images/videos appear once their task — or a later retry —
 * completes).
 *
 * Scope note: this covers all read-only slide-thumbnail surfaces — the playback
 * scene sidebar, the home-page recent-course cards, and the editor nav rail
 * (which renders through `SceneThumbnailContent`). The full-size editing canvas
 * is intentionally untouched (`@openmaic/renderer` v1 is read-only; editing is v2).
 */
export function SlideThumbnail({
  slide,
  size,
  viewportRatio,
  visible = true,
  sceneId,
}: SlideThumbnailProps) {
  const { t } = useI18n();
  const resolved = useResolvedSlideMedia(slide);
  const autoSize = size === undefined;

  const containerClass = autoSize
    ? 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none w-full h-full'
    : 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none';
  const containerStyle: CSSProperties | undefined = autoSize
    ? undefined
    : { width: `${size}px`, height: `${size * viewportRatio}px` };

  if (!visible) {
    return (
      <div className={containerClass} style={containerStyle}>
        <div className="placeholder w-full h-full flex justify-center items-center text-gray-400 text-sm">
          加载中 ...
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass} style={containerStyle}>
      <SlideCanvas
        slide={resolved.slide}
        chrome={false}
        renderImage={(element, src, defaultContent) =>
          renderThumbnailImage(
            element,
            src,
            defaultContent,
            resolved.byElementId[element.id],
            t('settings.mediaGenerationDisabled'),
            t('settings.mediaRetry'),
            () => {
              const media = resolved.byElementId[element.id];
              if (media?.ref) {
                retryMediaTask(media.ref, { elementId: element.id, sceneId, slideId: slide.id });
              }
            },
          )
        }
        renderVideo={(element) =>
          renderThumbnailVideo(
            element,
            resolved.byElementId[element.id],
            t('settings.mediaGenerationDisabled'),
            t('settings.mediaRetry'),
            () => {
              const media = resolved.byElementId[element.id];
              if (media?.ref) {
                retryMediaTask(media.ref, { elementId: element.id, sceneId, slideId: slide.id });
              }
            },
          )
        }
        videoInteractive={false}
      />
    </div>
  );
}
