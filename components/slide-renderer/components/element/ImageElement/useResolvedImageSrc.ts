'use client';

import type { PPTImageElement } from '@/lib/types/slides';
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
 * Behavior is strictly additive: for non-placeholder src (every legacy /
 * direct-URL / data-URL image), `resolvedSrc === elementInfo.src` and the
 * store is not subscribed to. Mirrors the playback resolution exactly so the
 * two variants stay aligned.
 */
export function useResolvedImageSrc(elementInfo: PPTImageElement): ResolvedImageSrc {
  // Only subscribe to media store when inside a classroom (stageId provided
  // via context). Homepage thumbnails have no stageId context → skip store
  // to prevent cross-course contamination.
  const stageId = useMediaStageId();
  const isPlaceholder = !!stageId && isMediaPlaceholder(elementInfo.src);
  const task = useMediaGenerationStore((s) => {
    if (!isPlaceholder) return undefined;
    const t = s.tasks[elementInfo.src];
    // Only use task if it belongs to the current stage.
    if (t && t.stageId !== stageId) return undefined;
    return t;
  });
  const resolvedSrc = task?.status === 'done' && task.objectUrl ? task.objectUrl : elementInfo.src;
  return { resolvedSrc, isPlaceholder, task };
}
