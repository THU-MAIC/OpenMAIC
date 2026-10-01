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
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';

import type { RunMediaView } from './types';

/** The task a run's media state renders as (`objectUrl` names the allocated asset, which the renderers lease). */
export function mediaTaskOfRun(
  stageId: string,
  elementId: string,
  state: RunMediaView,
  previous: MediaTask | undefined,
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
      return {
        ...base,
        status: 'failed',
        error: 'Generation disabled',
        errorCode: 'GENERATION_DISABLED',
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        error: state.message ?? 'Media generation failed',
        ...(state.errorCode ? { errorCode: state.errorCode } : {}),
      };
  }
}

/** Mirror a run's media states into the media store. */
export function applyRunMedia(stageId: string, media: Record<string, RunMediaView>): void {
  const entries = Object.entries(media);
  if (entries.length === 0) return;
  useMediaGenerationStore.setState((store) => {
    const tasks = { ...store.tasks };
    let changed = false;
    for (const [elementId, state] of entries) {
      const previous = tasks[elementId];
      const next = mediaTaskOfRun(stageId, elementId, state, previous);
      if (
        previous &&
        previous.status === next.status &&
        previous.objectUrl === next.objectUrl &&
        previous.errorCode === next.errorCode &&
        previous.stageId === next.stageId
      ) {
        continue;
      }
      tasks[elementId] = next;
      changed = true;
    }
    return changed ? { tasks } : store;
  });
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
