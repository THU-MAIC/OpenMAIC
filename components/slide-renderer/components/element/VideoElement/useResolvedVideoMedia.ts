'use client';

import type { PPTVideoElement } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import {
  isConcreteMediaAddress,
  renderableMediaUrl,
  useResolvedMediaRef,
  type MediaResolution,
} from '@/lib/media/resolve-media-ref';

export function videoMediaRefForResolution(element: PPTVideoElement): string | undefined {
  return (
    getVideoMediaRefForElement(element) ??
    (element.src && !isConcreteMediaAddress(element.src) ? element.src : undefined)
  );
}

export interface ResolvedVideoMedia {
  readonly mediaRef: string | undefined;
  readonly resolution: MediaResolution;
  readonly posterResolution: MediaResolution;
  readonly resolvedSrc: string | undefined;
  readonly resolvedPoster: string | undefined;
}

/** Shared direct-video binding used by both the read-only and editor elements. */
export function useResolvedVideoMedia(
  element: PPTVideoElement,
  task: MediaTask | undefined,
  mediaGenerationDisabled: boolean,
): ResolvedVideoMedia {
  const mediaRef = videoMediaRefForResolution(element);
  const resolution = useResolvedMediaRef(mediaRef ?? element.src, task, mediaGenerationDisabled);
  const posterResolution = useResolvedMediaRef(
    element.poster,
    task?.poster ? { ...task, objectUrl: task.poster } : undefined,
  );
  return {
    mediaRef,
    resolution,
    posterResolution,
    resolvedSrc: renderableMediaUrl(resolution),
    resolvedPoster: renderableMediaUrl(posterResolution),
  };
}
