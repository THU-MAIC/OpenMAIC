'use client';

/** The owner's active generation runs, for course lists (see `OwnerRunsWatcher`). */
import { useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

import { listActiveGenerationRuns } from './api';
import { OwnerRunsWatcher } from './owner-runs';
import { subscribeRunsChanged } from './runs-changed';
import type { RunSnapshot } from './types';

const log = createLogger('OwnerRuns');

export { mergeOwnerRun } from './owner-runs';

export interface OwnerRunsOptions {
  /** A run gained its course, or finished: the course list should be read again. */
  onCourseChanged?: (run: RunSnapshot) => void;
}

export function useOwnerRuns(options: OwnerRunsOptions = {}): {
  runs: RunSnapshot[];
  forget: (runId: string) => void;
} {
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const watcherRef = useRef<OwnerRunsWatcher | null>(null);
  const onCourseChangedRef = useRef(options.onCourseChanged);
  useEffect(() => {
    onCourseChangedRef.current = options.onCourseChanged;
  });

  useEffect(() => {
    const watcher = new OwnerRunsWatcher({
      listActive: listActiveGenerationRuns,
      openStream:
        typeof EventSource === 'undefined'
          ? null
          : () => new EventSource('/api/generation-runs/events'),
      onChange: setRuns,
      onCourseChanged: (run) => onCourseChangedRef.current?.(run),
      onWarn: (message, error) => log.warn(`${message}:`, error),
    });
    watcherRef.current = watcher;
    void watcher.poll();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void watcher.poll('visible');
    };
    document.addEventListener('visibilitychange', onVisible);
    // A run started (or discarded) in another tab of this browser: read now.
    const unsubscribe = subscribeRunsChanged(() => void watcher.poll());
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      watcher.close();
      if (watcherRef.current === watcher) watcherRef.current = null;
    };
  }, []);

  const forget = (runId: string) => watcherRef.current?.forget(runId);
  return { runs, forget };
}
