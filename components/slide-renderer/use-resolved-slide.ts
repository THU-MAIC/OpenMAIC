'use client';

import { useMemo } from 'react';
import type { PPTElement, Slide } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import { isMediaPlaceholder, useMediaGenerationStore } from '@/lib/store/media-generation';

/**
 * Media-generation task key for an element, matching the full-size canvas:
 * images are keyed by their generated placeholder src, videos by mediaRef or
 * generated video placeholder. The hook below keeps renderer-backed slide
 * surfaces in sync with generated media without coupling renderer to app stores.
 */
function mediaTaskKeyFor(el: PPTElement): string | undefined {
  if (el.type === 'video') return getVideoMediaRefForElement(el);
  if (el.type === 'image' && el.src && isMediaPlaceholder(el.src)) return el.src;
  return undefined;
}

export function resolveSlideMedia(
  slide: Slide,
  stageId: string | undefined,
  tasks: Record<string, MediaTask>,
  options: { preserveUnresolvedImagePlaceholders?: boolean } = {},
): Slide {
  if (!stageId) return slide;
  const elements = slide.elements.map((el) => {
    const key = mediaTaskKeyFor(el);
    if (!key) return el;
    const task = tasks[key];
    if (task && task.stageId === stageId && task.status === 'done' && task.objectUrl) {
      return el.type === 'video'
        ? { ...el, src: task.objectUrl, poster: task.poster ?? el.poster }
        : { ...el, src: task.objectUrl };
    }
    if (
      el.type === 'image' &&
      el.src &&
      isMediaPlaceholder(el.src) &&
      !options.preserveUnresolvedImagePlaceholders
    ) {
      return { ...el, src: '' };
    }
    if (el.type === 'video' && el.src && isMediaPlaceholder(el.src)) {
      return { ...el, mediaRef: el.mediaRef ?? el.src, src: '' };
    }
    return el;
  });
  return { ...slide, elements };
}

export function useResolvedSlide(
  slide: Slide,
  options: { preserveUnresolvedImagePlaceholders?: boolean } = {},
): Slide {
  const stageId = useMediaStageId();
  const preserveUnresolvedImagePlaceholders = options.preserveUnresolvedImagePlaceholders;

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
      const poster = task && task.stageId === stageId && task.status === 'done' ? task.poster : '';
      sig += `${key}|${url}|${poster ?? ''}|`;
    }
    return sig;
  });

  return useMemo(() => {
    if (!signature) return slide;
    return resolveSlideMedia(slide, stageId, useMediaGenerationStore.getState().tasks, {
      preserveUnresolvedImagePlaceholders,
    });
  }, [slide, stageId, signature, preserveUnresolvedImagePlaceholders]);
}
