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

function isLegacySequentialVideoRef(value: string | undefined): boolean {
  return !!value && /^gen_vid_\d+$/i.test(value);
}

export function selectVideoMediaTaskForElement(
  tasks: Readonly<Record<string, MediaTask>>,
  element: PPTVideoElement,
  stageId: string | undefined,
): MediaTask | undefined {
  const mediaRef = videoMediaRefForResolution(element);
  if (!stageId || !mediaRef) return undefined;

  const targeted = tasks[element.id];
  if (targeted?.stageId === stageId) return targeted;

  const exact = tasks[mediaRef];
  if (exact && exact.stageId !== stageId) return undefined;
  if (exact) return exact;

  const reconciled = Object.values(tasks).find(
    (candidate) => candidate.stageId === stageId && candidate.placeholderRef === mediaRef,
  );
  if (reconciled) return reconciled;

  const storedVideos = Object.values(tasks).filter(
    (candidate) =>
      candidate.stageId === stageId && candidate.type === 'video' && candidate.status === 'done',
  );
  return isLegacySequentialVideoRef(mediaRef) && storedVideos.length === 1
    ? storedVideos[0]
    : undefined;
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
