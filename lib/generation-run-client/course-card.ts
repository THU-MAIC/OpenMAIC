/**
 * What a course card says about the run producing its course (RFC #1754 §E):
 * outlining, waiting for confirmation, generating n/m, or paused after a
 * failure.
 */
import type { RunSnapshot } from './types';

export type CourseRunStatus =
  | { kind: 'outlining' }
  | { kind: 'awaiting-confirmation' }
  | { kind: 'generating'; completed: number; total: number }
  | { kind: 'paused' };

export function courseRunStatus(
  run: Pick<RunSnapshot, 'state' | 'progress'>,
): CourseRunStatus | null {
  switch (run.state) {
    case 'preparing':
    case 'outlining':
      return { kind: 'outlining' };
    case 'awaiting_outline_confirmation':
      return { kind: 'awaiting-confirmation' };
    case 'generating':
      return {
        kind: 'generating',
        completed: run.progress.scenesCompleted,
        total: run.progress.scenesTotal,
      };
    case 'paused':
      return { kind: 'paused' };
    default:
      return null;
  }
}

/** Where opening the card goes: the course once it exists and its outline is settled, else the run's preview. */
export function courseRunHref(run: Pick<RunSnapshot, 'id' | 'state' | 'stageId'>): string {
  if (run.stageId && run.state !== 'awaiting_outline_confirmation') {
    return `/classroom/${encodeURIComponent(run.stageId)}`;
  }
  return `/generation-preview?run=${encodeURIComponent(run.id)}`;
}

/** The name a card shows before its course exists. */
export function pendingCourseName(run: Pick<RunSnapshot, 'outline' | 'input'>): string {
  const title = run.outline?.courseTitle?.trim();
  if (title) return title;
  const requirement = run.input.requirement.trim();
  return requirement.length <= 500 ? requirement : `${requirement.slice(0, 500).trim()}...`;
}

/** The run producing each course that already exists, by course id. */
export function runsByCourse<T extends Pick<RunSnapshot, 'stageId'>>(
  runs: readonly T[],
): Map<string, T> {
  return new Map(
    runs.flatMap((run): Array<[string, T]> => (run.stageId ? [[run.stageId, run]] : [])),
  );
}

/**
 * The runs whose course is not in the course list yet: a list shows each as a
 * card (or row) of its own, in the runs' order, until its course is listed.
 */
export function pendingCourseRuns<T extends Pick<RunSnapshot, 'stageId'>>(
  runs: readonly T[],
  listedStageIds: ReadonlySet<string>,
): T[] {
  return runs.filter((run) => !run.stageId || !listedStageIds.has(run.stageId));
}
