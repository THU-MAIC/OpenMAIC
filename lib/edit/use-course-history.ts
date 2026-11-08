'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { stepCourseTimeline, sweepExpiredCourseSteps } from './course-edit';
import { EMPTY_LINE, useCourseTimeline } from './course-timeline';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { TimelineDirection } from './course-timeline';

const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/**
 * The current course's undo and redo. Mounted wherever the buttons are, which
 * also keeps steps whose media is about to be reclaimed from lingering.
 */
export function useCourseHistory() {
  const { t } = useI18n();
  const stageId = useStageStore((state) => state.stage?.id);
  const line = useCourseTimeline((state) => (stageId ? state.lines[stageId] : undefined));
  const { past, future } = line ?? EMPTY_LINE;

  const sweep = useCallback(() => {
    const expired = sweepExpiredCourseSteps();
    if (expired > 0) toast(t('edit.courseHistory.stepExpired'), { duration: 3000 });
    return expired;
  }, [t]);

  useEffect(() => {
    sweep();
    const timer = setInterval(sweep, EXPIRY_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [stageId, sweep]);

  const step = useCallback(
    (direction: TimelineDirection) => {
      // The step about to run may be the one that just left: pressing again acts
      // on what is now there, so this press only reports it.
      if (sweep() === 0) stepCourseTimeline(direction);
    },
    [sweep],
  );
  const undo = useCallback(() => step('undo'), [step]);
  const redo = useCallback(() => step('redo'), [step]);

  return useMemo(
    () => ({ canUndo: past.length > 0, canRedo: future.length > 0, undo, redo }),
    [past.length, future.length, undo, redo],
  );
}

/** Text fields and the text editors keep these keys for their own undo. */
function keepsOwnHistory(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null
  );
}

/** Which timeline step a keydown asks for, if any. */
export function timelineShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): TimelineDirection | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

export function useCourseTimelineShortcuts(enabled: boolean): void {
  const { t } = useI18n();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = timelineShortcut(event);
      if (!direction || event.defaultPrevented || keepsOwnHistory(event.target)) return;
      event.preventDefault();
      if (event.repeat) return;
      const expired = sweepExpiredCourseSteps();
      if (expired > 0) toast(t('edit.courseHistory.stepExpired'), { duration: 3000 });
      else stepCourseTimeline(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, t]);
}
