/**
 * The commands the browser sends a run, each idempotent by its `commandId`.
 *
 * One user intent is one command: the id is derived from what the command
 * acts on (the outline revision, the failure the run is paused at, the media
 * failure), so a repeated click or a resend after a lost answer carries the
 * same id and the server answers what the first one did.
 */
import { confirmRunOutline, newCommandId, retryRun } from './api';
import type { RunView } from './types';
import type { SceneOutline } from '@/lib/types/generation';

const commandIds = new Map<string, string>();

/** The command id for one intent, minted once per key. */
export function commandIdFor(key: string, kind: string): string {
  let id = commandIds.get(key);
  if (!id) {
    id = newCommandId(kind);
    commandIds.set(key, id);
  }
  return id;
}

/** Test hook. */
export function resetCommandIds(): void {
  commandIds.clear();
}

/** Confirm the outline the run waits on, with the learner's edit when there is one. */
export function confirmOutline(
  view: Pick<RunView, 'runId' | 'outline'>,
  editedOutlines?: SceneOutline[],
): Promise<{ state: string; outlineRevision: number }> {
  if (!view.outline) throw new Error('The run has no outline to confirm');
  const revision = view.outline.revision;
  const key = `${view.runId}:confirm:${revision}${editedOutlines ? `:${JSON.stringify(editedOutlines)}` : ''}`;
  return confirmRunOutline(view.runId, {
    commandId: commandIdFor(key, 'confirm'),
    outlineRevision: revision,
    ...(editedOutlines ? { outlines: editedOutlines } : {}),
  });
}

/** Re-run the step a paused run stopped at. Answers the seq of the command's commit. */
export async function retryPausedRun(
  view: Pick<RunView, 'runId' | 'failedSeq' | 'error'>,
): Promise<number> {
  const key = `${view.runId}:retry:${view.error?.step ?? ''}:${view.failedSeq}`;
  const result = (await retryRun(view.runId, { commandId: commandIdFor(key, 'retry') })) as {
    seq?: unknown;
  };
  return typeof result.seq === 'number' ? result.seq : view.failedSeq;
}

/** Generate one failed (or disabled) image or video of the run again. */
export async function retryRunMedia(
  view: Pick<RunView, 'runId' | 'media'>,
  elementId: string,
): Promise<void> {
  const key = `${view.runId}:media:${elementId}:${view.media[elementId]?.seq ?? 0}`;
  await retryRun(view.runId, {
    commandId: commandIdFor(key, 'retry-media'),
    media: { elementId },
  });
}
