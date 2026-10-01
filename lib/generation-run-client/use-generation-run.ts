'use client';

/** Follow one generation run from a React component (see `RunFollower`). */
import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

import { fetchGenerationRun } from './api';
import { RunFollower, type RunFollowerState, type RunFollowStatus } from './follower';
import type { RunView } from './types';

const log = createLogger('GenerationRun');

export type { RunFollowStatus } from './follower';

export interface FollowedRun {
  view: RunView | null;
  status: RunFollowStatus;
  /** True once the stream replayed everything the run logged before it attached. */
  caughtUp: boolean;
  /** Read the snapshot again (after a refused command, for instance). */
  refresh: () => Promise<void>;
}

const INITIAL: RunFollowerState = { view: null, status: 'loading', caughtUp: false };

export function useGenerationRun(runId: string | null): FollowedRun {
  const [state, setState] = useState<{ runId: string | null; value: RunFollowerState }>({
    runId,
    value: INITIAL,
  });
  const followerRef = useRef<RunFollower | null>(null);

  useEffect(() => {
    if (!runId) return;
    const follower = new RunFollower(runId, {
      fetchSnapshot: fetchGenerationRun,
      openEvents: typeof EventSource === 'undefined' ? null : (url: string) => new EventSource(url),
      onChange: (value) => setState({ runId, value }),
      onWarn: (message, error) => log.warn(`${message}:`, error),
    });
    followerRef.current = follower;
    void follower.start();
    return () => {
      follower.close();
      if (followerRef.current === follower) followerRef.current = null;
    };
  }, [runId]);

  const refresh = useCallback(async () => {
    await followerRef.current?.resync();
  }, []);

  // A state left from another run id reads as loading.
  const value = state.runId === runId ? state.value : INITIAL;
  return {
    view: value.view,
    status: runId ? value.status : 'missing',
    caughtUp: value.caughtUp,
    refresh,
  };
}
