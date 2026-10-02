/**
 * A run's images and videos in the classroom's media store.
 *
 * The slide renderers draw a generated element from the media store's task
 * for it (keyed by the placeholder the outline gave it): pending and
 * generating show the skeleton, done shows the asset, a failure shows the
 * placeholder with Retry, `GENERATION_DISABLED` the disabled placeholder.
 * The run's `media` states map onto those tasks one to one, and a Retry on a
 * course a run produces is the run's media retry command, not a provider call
 * from the browser.
 */
import { getClientTranslation } from '@/lib/i18n';
import { isRetryableMediaFailure } from '@/lib/media/media-failure';
import { recordMediaAllocation } from '@/lib/media/pending-media-allocations';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';

import type { RunMediaView } from './types';

/**
 * Which kinds a Retry could generate now (the slot resolves). A skipped item
 * (its slot was off when the run reached it) shows the disabled placeholder
 * while the slot is still off, and the run's Retry once it is on.
 */
export interface RunMediaSlots {
  image: boolean;
  video: boolean;
}

/** The task a run's media state renders as (`objectUrl` names the allocated asset, which the renderers lease). */
export function mediaTaskOfRun(
  stageId: string,
  elementId: string,
  state: RunMediaView,
  previous: MediaTask | undefined,
  slots: RunMediaSlots,
): MediaTask {
  const base: MediaTask = {
    elementId,
    type: state.mediaType,
    status: 'pending',
    prompt: previous?.prompt ?? '',
    params: previous?.params ?? {},
    retryCount: previous?.retryCount ?? 0,
    stageId,
  };
  switch (state.status) {
    case 'pending':
      return base;
    case 'generating':
      return { ...base, status: 'generating' };
    case 'done':
      return {
        ...base,
        status: 'done',
        ...(state.assetId ? { objectUrl: state.assetId } : {}),
        ...(state.posterAssetId ? { posterAssetId: state.posterAssetId } : {}),
      };
    case 'disabled':
      return slots[state.mediaType]
        ? {
            ...base,
            status: 'failed',
            error: getClientTranslation('generation.mediaGenerationFailed'),
            retryable: true,
          }
        : {
            ...base,
            status: 'failed',
            error: getClientTranslation('generation.mediaGenerationDisabled'),
            errorCode: 'GENERATION_DISABLED',
            retryable: false,
          };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        error: state.message ?? getClientTranslation('generation.mediaGenerationFailed'),
        ...(state.errorCode ? { errorCode: state.errorCode } : {}),
        // The run says whether its Retry would be accepted (a removed element is final).
        retryable: state.retryable ?? isRetryableMediaFailure(state),
      };
  }
}

/** Mirror a run's media states into the media store. */
export function applyRunMedia(
  stageId: string,
  media: Record<string, RunMediaView>,
  slots: RunMediaSlots,
): void {
  const entries = Object.entries(media);
  if (entries.length === 0) return;
  useMediaGenerationStore.setState((store) => {
    const tasks = { ...store.tasks };
    let changed = false;
    for (const [elementId, state] of entries) {
      const previous = tasks[elementId];
      const next = mediaTaskOfRun(stageId, elementId, state, previous, slots);
      if (
        previous &&
        previous.status === next.status &&
        previous.objectUrl === next.objectUrl &&
        previous.errorCode === next.errorCode &&
        previous.retryable === next.retryable &&
        previous.stageId === next.stageId
      ) {
        continue;
      }
      tasks[elementId] = next;
      changed = true;
    }
    return changed ? { tasks } : store;
  });
  // What the run placed, by placeholder: a browser save of a scene this tab
  // still holds with the placeholder writes the asset instead (the same
  // record the browser's own media pass keeps).
  for (const [elementId, state] of entries) {
    if (state.status === 'done' && state.assetId) {
      recordMediaAllocation({
        stageId,
        placeholderRef: elementId,
        assetId: state.assetId,
        ...(state.posterAssetId ? { posterAssetId: state.posterAssetId } : {}),
      });
    }
  }
}

type RunMediaRetry = (elementId: string) => Promise<void>;
const retries = new Map<string, RunMediaRetry>();

/** Route the media Retry of a course to its run while the classroom follows it. */
export function registerRunMediaRetry(stageId: string, retry: RunMediaRetry): () => void {
  retries.set(stageId, retry);
  return () => {
    if (retries.get(stageId) === retry) retries.delete(stageId);
  };
}

/** The run's media Retry for a course, when a run produces it. */
export function runMediaRetryFor(stageId: string | undefined): RunMediaRetry | undefined {
  return stageId ? retries.get(stageId) : undefined;
}
