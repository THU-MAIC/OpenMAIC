/**
 * The owner's conversations whose agent is running right now, as the workspace
 * rail knows them (its owner event stream keeps the list current).
 *
 * The classroom needs this for a course that is NOT the attached conversation's:
 * a course another conversation is still building looks finished between two
 * pages (every outline has its page), and only that conversation's run says
 * otherwise. An agent-built course names its conversation as its producer
 * (`outlineProducerRef`), so the classroom asks whether that one is running.
 *
 * This is a session-level signal, coarser than the attached conversation's
 * course-specific one (`sessionBuildsCourse`): the rail list carries only each
 * conversation's status, not which course its current request writes, so any
 * request in the producer conversation — even one that never touches this
 * course — holds the course end back until it finishes. It is therefore used
 * only when the producer is NOT the attached conversation; for the attached
 * one, the fold knows exactly which courses the run is writing.
 *
 * Empty outside the workspace: the standalone classroom has no owner stream.
 */
import { create } from 'zustand';

import type { ProHomeSessionItem } from './pro-home-data';

interface RunningSessionsState {
  readonly ids: ReadonlySet<string>;
  readonly setFromSessions: (
    sessions: readonly Pick<ProHomeSessionItem, 'id' | 'status'>[],
  ) => void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useRunningSessions = create<RunningSessionsState>((set, get) => ({
  ids: EMPTY,
  setFromSessions: (sessions) => {
    const ids = new Set(
      sessions
        .filter((session) => session.status === 'running' || session.status === 'queued')
        .map((session) => session.id),
    );
    const current = get().ids;
    if (ids.size === current.size && [...ids].every((id) => current.has(id))) return;
    set({ ids: ids.size === 0 ? EMPTY : ids });
  },
}));

/**
 * The conversation that produces this course is running: more pages may land.
 *
 * False when the producer is the attached conversation (`attachedSessionId`):
 * there `sessionBuildsCourse` answers per course, and this coarser check would
 * hold the course end back for an unrelated follow-up in that conversation.
 */
export function producerSessionRunning(
  ids: ReadonlySet<string>,
  producerRef: string | null | undefined,
  attachedSessionId: string | null | undefined,
): boolean {
  if (!producerRef || producerRef === attachedSessionId) return false;
  return ids.has(producerRef);
}
