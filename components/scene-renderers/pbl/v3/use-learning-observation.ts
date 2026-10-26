'use client';
import { useCallback, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import type { LearningSnapshot } from '@/lib/pbl/v3/event-stream';

/** HTTP reads capture their baseline before awaiting; SSE replaces that baseline. */
export function useLearningObservation() {
  const [view, setView] = useState<LearningView | null>(null);
  const [workbench, setWorkbench] = useState<LearningWorkbench | null>(null);
  const latestView = useRef<LearningView | null>(null);
  const updateView = useCallback((next: LearningView, baseline = latestView.current) => {
    const current = latestView.current;
    if (!current || current.id !== next.id) return false;
    const activity = next.activitySequence ?? 0;
    const previousActivity = current.activitySequence ?? 0;
    if (
      next.revision < current.revision ||
      (next.revision === current.revision &&
        (activity < previousActivity || (activity === previousActivity && current !== baseline)))
    )
      return false;
    latestView.current = next;
    setView(next);
    return true;
  }, []);
  const receive = useCallback(
    (snapshot: LearningSnapshot) => {
      // Never combine an accepted learning view with a rejected workspace snapshot.
      if (updateView(snapshot.view)) setWorkbench(snapshot.workbench);
    },
    [updateView],
  );
  const openView = useCallback((next: LearningView) => {
    latestView.current = next;
    setView(next);
    setWorkbench(null);
  }, []);
  return { view, workbench, latestView, updateView, receive, openView };
}
