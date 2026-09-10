'use client';

import { useEffect, useRef } from 'react';
import type { SessionStatus } from '@/lib/workbench/session-store';

/**
 * Collapse arbitrarily many reload requests into one active load and, at
 * most, one follow-up. A response is committed only when no newer request was
 * made while it was in flight, so an old course-list snapshot can never win.
 */
export function createCoalescedLatestLoader<T>({
  load,
  commit,
  fail,
}: {
  readonly load: () => Promise<T>;
  readonly commit: (value: T) => void;
  readonly fail: (error: unknown) => void;
}) {
  let requested = 0;
  let inFlight: Promise<void> | null = null;

  const drain = async () => {
    try {
      while (true) {
        const request = requested;
        try {
          // Scheduling load through a promise also prevents a synchronous
          // throw from completing drain before its promise is assigned below.
          const value = await Promise.resolve().then(load);
          if (request === requested) commit(value);
        } catch (error) {
          if (request === requested) fail(error);
        }
        if (request === requested) return;
      }
    } finally {
      // Clear synchronously inside drain's settlement turn. Using
      // `drain().finally(...)` leaves a microtask window where a new request
      // observes the old promise and is accepted without starting a new drain.
      inFlight = null;
    }
  };

  return () => {
    requested += 1;
    if (!inFlight) {
      inFlight = drain();
    }
    return inFlight;
  };
}

/**
 * Refresh the navigation's authoritative course summary at the durable
 * boundaries that matter.
 *
 * Three triggers, ONE sink (`reload`) — the point being that the left rail has a
 * single refresh mechanism rather than one per feature:
 *
 *  - the FIRST committed page of the attached run, the moment a generated course
 *    becomes worth listing;
 *  - the run's TERMINAL edge, which calibrates its final title/count/order;
 *  - every LIBRARY write the run makes (`library_changed` folded into
 *    `libraryRevision`): a stage created, a folder created, a course filed.
 *
 * Page checkpoints BETWEEN the first and the last deliberately do nothing: the
 * course is already listed and its row does not change per page.
 *
 * The library counter is read as a DELTA against the value first seen for this
 * run, never as "nonzero": a session that created three folders an hour ago
 * replays as `libraryRevision === 3` in one commit, and refetching then is a
 * redundant read of the list the shell just loaded on mount. Only an increase
 * observed while attached is news.
 */
export function useGeneratedCourseDiscoverySync({
  sessionId,
  stageId,
  pageCount,
  status,
  libraryRevision = 0,
  reload,
}: {
  readonly sessionId: string | null;
  readonly stageId: string | null;
  readonly pageCount: number;
  readonly status: SessionStatus;
  /**
   * `WorkbenchFold.libraryRevision` — how many library writes this run has made.
   * Optional so a caller that does not track it keeps the page-boundary
   * behaviour exactly as it was.
   */
  readonly libraryRevision?: number;
  readonly reload: () => void;
}) {
  const runRef = useRef<string | null>(null);
  const firstPageRef = useRef(false);
  const firstPageJustRefreshedRef = useRef(false);
  const terminalRef = useRef(false);
  /** The library counter this run was last reconciled against; null = not yet seen. */
  const librarySeenRef = useRef<number | null>(null);

  useEffect(() => {
    const run = sessionId && stageId ? `${sessionId}\u0000${stageId}` : null;
    if (runRef.current !== run) {
      runRef.current = run;
      firstPageRef.current = false;
      terminalRef.current = false;
      librarySeenRef.current = null;
    }
    firstPageJustRefreshedRef.current = false;
    if (!run || pageCount === 0 || firstPageRef.current) return;
    firstPageRef.current = true;
    firstPageJustRefreshedRef.current = true;
    reload();
  }, [pageCount, reload, sessionId, stageId, status]);

  useEffect(() => {
    const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    if (!terminal) {
      terminalRef.current = false;
      return;
    }
    if (!sessionId || !stageId || pageCount === 0 || terminalRef.current) return;
    terminalRef.current = true;
    // A completed-session replay can reveal its first page and terminal state
    // in one commit. The one authoritative terminal snapshot satisfies both
    // boundaries; do not manufacture a redundant serial follow-up request.
    if (firstPageJustRefreshedRef.current) return;
    reload();
  }, [pageCount, reload, sessionId, stageId, status]);

  useEffect(() => {
    // A library write needs neither a stage nor a page: `create_folder` and
    // `create_stage` are precisely the cases where the run owns nothing with a
    // page yet, which is why the two page boundaries above cannot cover them.
    if (!sessionId) {
      librarySeenRef.current = null;
      return;
    }
    const seen = librarySeenRef.current;
    librarySeenRef.current = libraryRevision;
    // The first observation for this run only establishes the baseline: a
    // replayed backlog is already reflected in the list loaded on mount.
    if (seen === null || libraryRevision <= seen) return;
    reload();
  }, [libraryRevision, reload, sessionId]);
}
