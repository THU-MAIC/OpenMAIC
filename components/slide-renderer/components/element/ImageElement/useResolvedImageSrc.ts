'use client';

import type { PPTImageElement } from '@maic/dsl';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import {
  useMediaGenerationStore,
  isMediaPlaceholder,
  type MediaTask,
} from '@/lib/store/media-generation';

export interface ResolvedImageSrc {
  /**
   * The src to actually feed to `<img>`: the generated `objectUrl` when the
   * placeholder's task is done; otherwise the original `elementInfo.src`.
   * For non-placeholder src this is byte-equal to `elementInfo.src`.
   */
  readonly resolvedSrc: string;
  readonly isPlaceholder: boolean;
  readonly task: MediaTask | undefined;
}

/**
 * Pure resolver — no hooks. Given an image element plus the already-resolved
 * stageId and possibly-keyed task, computes the final resolution shape.
 * Splitting this out of the hook keeps the logic unit-testable in a plain
 * node environment (no RTL/jsdom needed).
 *
 * Behavior is strictly additive: for non-placeholder src (every legacy /
 * direct-URL / data-URL image), `resolvedSrc === elementInfo.src`. For a
 * placeholder, the task is honored only if it belongs to the current stage
 * (cross-course contamination guard) and its objectUrl is set.
 */
export function resolveImageSrc(
  elementInfo: PPTImageElement,
  stageId: string | undefined,
  task: MediaTask | undefined,
): ResolvedImageSrc {
  const isPlaceholder = !!stageId && isMediaPlaceholder(elementInfo.src);
  const effectiveTask = isPlaceholder && task && task.stageId === stageId ? task : undefined;
  const resolvedSrc =
    effectiveTask?.status === 'done' && effectiveTask.objectUrl
      ? effectiveTask.objectUrl
      : elementInfo.src;
  return { resolvedSrc, isPlaceholder, task: effectiveTask };
}

/**
 * Resolve a slide image element's src against the media generation store so
 * `gen_img_*` placeholders display the generated objectUrl once the task is
 * ready. Shared by:
 *
 *   - `BaseImageElement` — the read-only playback variant (consumes the full
 *     return shape for skeleton / error / disabled UX);
 *   - `ImageElement` (this folder's `index.tsx`) — the interactive editor
 *     canvas variant, which historically rendered `elementInfo.src` raw and
 *     therefore showed a broken-image icon when entering Pro mode on any
 *     slide whose image element was a generation placeholder.
 *
 * Only subscribe to the media store when inside a classroom (stageId provided
 * via context). Homepage thumbnails have no stageId context → skip the store
 * to prevent cross-course contamination.
 */
export function useResolvedImageSrc(elementInfo: PPTImageElement): ResolvedImageSrc {
  const stageId = useMediaStageId();
  // Tight selector: only the task keyed by this src (and only for placeholder
  // src), so unrelated task updates don't re-render the renderer.
  const task = useMediaGenerationStore((s) => {
    if (!stageId || !isMediaPlaceholder(elementInfo.src)) return undefined;
    return s.tasks[elementInfo.src];
  });
  return resolveImageSrc(elementInfo, stageId, task);
}
