'use client';

/**
 * The owner's active generation runs, for course lists: `GET
 * /api/generation-runs?active=1` on mount, then, while any run is active, the
 * owner stream (`GET /api/generation-runs/events`), which sends every active
 * run at attach and a run's snapshot each time it changes, including the
 * change that completes or ends it.
 */
import { useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

import { listActiveGenerationRuns } from './api';
import { isFinishedRunState, type RunSnapshot } from './types';

const log = createLogger('OwnerRuns');

/** How often an idle course list looks for runs started elsewhere. */
const IDLE_POLL_MS = 30_000;

export interface OwnerRunsOptions {
  /** A run gained its course, or finished: the course list should be read again. */
  onCourseChanged?: (run: RunSnapshot) => void;
}

/** Keep each run's newest snapshot; finished runs leave the list. */
export function mergeOwnerRun(runs: readonly RunSnapshot[], run: RunSnapshot): RunSnapshot[] {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index >= 0 && runs[index]!.seq > run.seq) return runs as RunSnapshot[];
  const rest = runs.filter((candidate) => candidate.id !== run.id);
  if (isFinishedRunState(run.state)) return rest;
  const next = [...rest];
  next.splice(index >= 0 ? index : 0, 0, run);
  return next;
}

export function useOwnerRuns(options: OwnerRunsOptions = {}): {
  runs: RunSnapshot[];
  forget: (runId: string) => void;
} {
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const runsRef = useRef<RunSnapshot[]>([]);
  const onCourseChangedRef = useRef(options.onCourseChanged);
  useEffect(() => {
    onCourseChangedRef.current = options.onCourseChanged;
  });

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const replace = (next: RunSnapshot[]) => {
      const previous = runsRef.current;
      runsRef.current = next;
      if (!cancelled) setRuns(next);
      // A run that left the list finished: its course is in the library now.
      const left = previous.filter((run) => !next.some((candidate) => candidate.id === run.id));
      for (const run of left) onCourseChangedRef.current?.(run);
      for (const run of next) {
        const before = previous.find((candidate) => candidate.id === run.id);
        if (run.stageId && before && before.stageId !== run.stageId) {
          onCourseChangedRef.current?.(run);
        }
      }
      if (next.length === 0) stopStream();
    };

    const schedulePoll = () => {
      if (cancelled || pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void poll();
      }, IDLE_POLL_MS);
    };

    const stopStream = () => {
      source?.close();
      source = null;
      schedulePoll();
    };

    const openStream = () => {
      if (cancelled || source || typeof EventSource === 'undefined') return;
      const stream = new EventSource('/api/generation-runs/events');
      source = stream;
      stream.addEventListener('runs', (message) => {
        try {
          const frame = JSON.parse((message as MessageEvent<string>).data) as {
            runs?: RunSnapshot[];
          };
          if (Array.isArray(frame.runs)) replace(frame.runs);
        } catch {
          /* a malformed frame changes nothing */
        }
      });
      stream.addEventListener('run', (message) => {
        try {
          const frame = JSON.parse((message as MessageEvent<string>).data) as {
            run?: RunSnapshot;
          };
          if (frame.run) replace(mergeOwnerRun(runsRef.current, frame.run));
        } catch {
          /* a malformed frame changes nothing */
        }
      });
    };

    // The owner stream is held while there is a run to follow; with none, the
    // list is read again now and then (a run started on another device or tab
    // shows up then), so an idle home page holds no open connection.
    async function poll() {
      try {
        const active = await listActiveGenerationRuns();
        if (cancelled) return;
        replace(active);
        if (active.length > 0 && typeof EventSource !== 'undefined') openStream();
        else schedulePoll();
      } catch (error) {
        log.warn('Listing the active generations failed:', error);
        schedulePoll();
      }
    }
    void poll();

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  const forget = (runId: string) => {
    runsRef.current = runsRef.current.filter((run) => run.id !== runId);
    setRuns(runsRef.current);
  };
  return { runs, forget };
}
