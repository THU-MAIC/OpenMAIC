'use client';

import { useMemo } from 'react';
import { Play } from 'lucide-react';
import type { Slide, PPTElement, PPTVideoElement } from '@openmaic/dsl';
import { isMediaPlaceholder, useMediaGenerationStore } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import { SlideCanvas } from '@openmaic/renderer';

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
}

/**
 * Media-generation task key for an element, matching what the full-size canvas
 * subscribes to: images are keyed by their `gen_img_*` placeholder src
 * (`useResolvedImageSrc`); videos are keyed by `mediaRef ?? gen_vid_* src`
 * (`getVideoMediaRefForElement`, as in `BaseVideoElement`) — a mediaRef-keyed
 * video may carry no placeholder src at all.
 */
function mediaTaskKeyFor(el: PPTElement): string | undefined {
  if (el.type === 'video') return getVideoMediaRefForElement(el);
  if (el.type === 'image' && el.src && isMediaPlaceholder(el.src)) return el.src;
  return undefined;
}

/**
 * Resolve a slide's generated-media refs against the media-generation store so
 * the thumbnail stays in sync as generation (and retries) complete.
 *
 * `@openmaic/renderer` is a pure package: it renders `element.src` as-is and knows
 * nothing about this app's async media generation. The store never mutates the
 * slide's elements (it keeps the `gen_*`/`mediaRef` key and tracks the
 * generated `objectUrl` in a task), so a static render would show the raw
 * placeholder forever — broken on first paint, and crucially NOT updating when
 * a retry finally succeeds. We bridge that here, reactively:
 *
 * - Done task → swap `src` to the generated `objectUrl` (and video `poster`).
 * - Pending/failed with a placeholder src → blank the `src` so the package
 *   renders nothing instead of a broken `<img>`/`<video>` for the raw ref.
 *   (A mediaRef-keyed video whose src is a real URL keeps it.)
 * - No stage context (e.g. home recent-course cards) → render raw, matching
 *   the legacy thumbnail's "skip the store off-classroom" behavior.
 */
function useResolvedSlide(slide: Slide): Slide {
  const stageId = useMediaStageId();

  // Subscribe via a primitive signature of just the resolutions THIS slide
  // cares about (task key → done objectUrl), not the whole tasks map. Strings
  // compare by value, so unrelated task churn (other slides' media
  // generating/retrying) doesn't re-render this thumbnail, and the memo below
  // re-runs only when one of our own refs actually resolves.
  const signature = useMediaGenerationStore((s) => {
    if (!stageId) return '';
    let sig = '';
    for (const el of slide.elements) {
      const key = mediaTaskKeyFor(el);
      if (!key) continue;
      const task = s.tasks[key];
      const url =
        task && task.stageId === stageId && task.status === 'done' && task.objectUrl
          ? task.objectUrl
          : '';
      sig += `${key}|${url}|`;
    }
    return sig;
  });

  return useMemo(() => {
    if (!stageId || !signature) return slide;
    const { tasks } = useMediaGenerationStore.getState();
    const elements = slide.elements.map((el) => {
      const key = mediaTaskKeyFor(el);
      if (!key) return el;
      const task = tasks[key];
      if (task && task.stageId === stageId && task.status === 'done' && task.objectUrl) {
        return el.type === 'video'
          ? { ...el, src: task.objectUrl, poster: task.poster ?? el.poster }
          : { ...el, src: task.objectUrl };
      }
      // Unresolved: blank a placeholder src so the renderer paints nothing
      // rather than a broken-media icon. A real (non-placeholder) src — e.g. a
      // mediaRef-keyed video that already carries a playable URL — is kept.
      if ((el.type === 'image' || el.type === 'video') && el.src && isMediaPlaceholder(el.src))
        return { ...el, src: '' };
      return el;
    });
    return { ...slide, elements };
  }, [slide, stageId, signature]);
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
function renderThumbnailVideo(element: PPTVideoElement) {
  const src = element.src && !isMediaPlaceholder(element.src) ? element.src : undefined;
  return (
    <>
      {src ? (
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
}: SlideThumbnailProps) {
  const resolvedSlide = useResolvedSlide(slide);
  const autoSize = size === undefined;

  const containerClass = autoSize
    ? 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none w-full h-full'
    : 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none';
  const containerStyle: React.CSSProperties | undefined = autoSize
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
      <SlideCanvas slide={resolvedSlide} chrome={false} renderVideo={renderThumbnailVideo} />
    </div>
  );
}
