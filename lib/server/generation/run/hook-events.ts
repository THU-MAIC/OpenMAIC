/**
 * The host's `onRunEvent` notifications of a run, derived from the durable
 * events a committed transition wrote (`./types.ts`), so every path that
 * commits a transition reports it the same way.
 */
import { reportGenerationRunEvent } from '@/lib/server/generation-run-hooks/runtime';
import type { GenerationRunAttributes } from '@/lib/server/generation-run-hooks/types';

import type { NewGenerationRunEvent } from './types';

/** The part of a run every notification carries, and what the transition left. */
export interface RunHookSubject {
  id: string;
  ownerId: string;
  hostAttributes?: GenerationRunAttributes | null;
  stageId: string | null;
  progress: { scenesTotal: number; scenesCompleted: number };
  error: { errorCode?: string } | null;
}

/**
 * Report what a committed transition of `run` (as committed) did.
 * `currentOwnerOf` follows the stored owner through its claims (the store's).
 */
export function reportCommittedRunEvents(
  run: RunHookSubject,
  events: readonly NewGenerationRunEvent[],
  currentOwnerOf: (storedOwnerId: string) => Promise<string>,
): void {
  const base = { runId: run.id, ownerId: run.ownerId, attributes: run.hostAttributes ?? {} };
  const currentOwner = () => currentOwnerOf(run.ownerId);
  for (const event of events) {
    switch (event.type) {
      case 'outline_ready':
        reportGenerationRunEvent(
          {
            ...base,
            type: 'outline-ready',
            scenesTotal: run.progress.scenesTotal,
          },
          currentOwner,
        );
        break;
      case 'scene_ready':
        reportGenerationRunEvent(
          {
            ...base,
            type: 'scene-appended',
            stageId: run.stageId ?? '',
            sceneIndex: event.data.index as number,
            sceneId: event.data.sceneId as string,
            scenesCompleted: run.progress.scenesCompleted,
            scenesTotal: run.progress.scenesTotal,
          },
          currentOwner,
        );
        break;
      case 'state':
        if (event.data.state === 'paused') {
          reportGenerationRunEvent(
            {
              ...base,
              type: 'paused',
              step: (event.data.step as string | null | undefined) ?? null,
              ...(run.error?.errorCode ? { errorCode: run.error.errorCode } : {}),
            },
            currentOwner,
          );
        }
        break;
      case 'completed':
        reportGenerationRunEvent(
          {
            ...base,
            type: 'completed',
            stageId: event.data.stageId as string,
          },
          currentOwner,
        );
        break;
      case 'ended':
        reportGenerationRunEvent(
          {
            ...base,
            type: 'ended',
            stageId: (event.data.stageId as string | null | undefined) ?? null,
          },
          currentOwner,
        );
        break;
      default:
        break;
    }
  }
}
