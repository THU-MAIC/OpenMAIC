'use client';

/**
 * The owner's active generation runs, for course lists: `GET
 * /api/generation-runs?active=1` on mount, then the owner stream (`GET
 * /api/generation-runs/events`), which sends every active run at attach and a
 * run's snapshot each time it changes, including the change that completes or
 * ends it.
 */
import { useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

import { listActiveGenerationRuns } from './api';
import { isFinishedRunState, type RunSnapshot } from './types';

const log = createLogger('OwnerRuns');

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
    const replace = (next: RunSnapshot[]) => {
      runsRef.current = next;
      if (!cancelled) setRuns(next);
    };
    const upsert = (run: RunSnapshot) => {
      const previous = runsRef.current.find((candidate) => candidate.id === run.id);
      replace(mergeOwnerRun(runsRef.current, run));
      const courseAppeared = !!run.stageId && previous?.stageId !== run.stageId;
      if (courseAppeared || isFinishedRunState(run.state)) {
        onCourseChangedRef.current?.(run);
      }
    };

    listActiveGenerationRuns()
      .then((active) => {
        if (!cancelled) replace(active);
      })
      .catch((error) => log.warn('Listing the active generations failed:', error));

    if (typeof EventSource === 'undefined') return () => void (cancelled = true);
    const source = new EventSource('/api/generation-runs/events');
    source.addEventListener('runs', (message) => {
      try {
        const frame = JSON.parse((message as MessageEvent<string>).data) as {
          runs?: RunSnapshot[];
        };
        if (!Array.isArray(frame.runs)) return;
        // The attach snapshot: runs that finished while the stream was away drop out.
        const known = new Map(runsRef.current.map((run) => [run.id, run]));
        replace(frame.runs);
        for (const run of frame.runs) {
          if (run.stageId && known.get(run.id)?.stageId !== run.stageId) {
            onCourseChangedRef.current?.(run);
          }
        }
      } catch {
        /* a malformed frame changes nothing */
      }
    });
    source.addEventListener('run', (message) => {
      try {
        const frame = JSON.parse((message as MessageEvent<string>).data) as { run?: RunSnapshot };
        if (frame.run) upsert(frame.run);
      } catch {
        /* a malformed frame changes nothing */
      }
    });
    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  const forget = (runId: string) => {
    runsRef.current = runsRef.current.filter((run) => run.id !== runId);
    setRuns(runsRef.current);
  };
  return { runs, forget };
}
