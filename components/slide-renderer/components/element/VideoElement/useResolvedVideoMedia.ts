'use client';

import type { PPTVideoElement } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';
import {
  renderableMediaUrl,
  useResolvedMediaRef,
  type MediaResolution,
} from '@/lib/media/resolve-media-ref';

export interface ResolvedVideoMedia {
  readonly mediaRef: string | undefined;
  readonly task: MediaTask | undefined;
  readonly resolution: MediaResolution;
  readonly posterResolution: MediaResolution;
  readonly resolvedSrc: string | undefined;
  readonly resolvedPoster: string | undefined;
}

/** Shared direct-video binding used by both the read-only and editor elements. */
export function useResolvedVideoMedia(
  element: PPTVideoElement,
  tasks: Readonly<Record<string, MediaTask>>,
  stageId: string | undefined,
  mediaGenerationDisabled: boolean,
): ResolvedVideoMedia {
  const binding = resolveVideoMediaForElement(tasks, element, stageId);
  const resolution = useResolvedMediaRef(binding.sourceRef, binding.task, mediaGenerationDisabled);
  const posterResolution = useResolvedMediaRef(binding.posterRef, binding.posterTask);
  return {
    mediaRef: binding.mediaRef,
    task: binding.task,
    resolution,
    posterResolution,
    resolvedSrc: renderableMediaUrl(resolution),
    resolvedPoster: renderableMediaUrl(posterResolution),
  };
}
