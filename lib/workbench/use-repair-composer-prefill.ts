'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { WorkbenchTranslator } from '@/lib/i18n/workbench';
import { makeCourseRef } from '@/lib/workbench/course-refs';
import { useCourseRefsStore } from '@/lib/store/course-refs';
import type { WorkbenchCourseNavigation } from '@/lib/workbench/panel-context';
import {
  canApplyWorkbenchComposerPrefill,
  type WorkbenchComposerPrefill,
} from '@/lib/workbench/interactive-repair-prefill';

/**
 * Apply only after the pane's selected session (or draft) actually owns this
 * composer and its course refs. The session bootstrap and repair handoff are
 * independent effects; applying earlier can lose the ref on attachOwner().
 */
export function useRepairComposerPrefill({
  prefill,
  composerOwnerId,
  expectedOwnerId,
  draft,
  navigation,
  replaceDraft,
  onConsumed,
  t,
  untitledCourse,
}: {
  readonly prefill: WorkbenchComposerPrefill | null;
  readonly composerOwnerId: string | null;
  readonly expectedOwnerId: string | null;
  readonly draft: string;
  readonly navigation: WorkbenchCourseNavigation | null;
  readonly replaceDraft: (value: string) => void;
  readonly onConsumed?: (id: number) => void;
  readonly t: WorkbenchTranslator;
  readonly untitledCourse: string;
}): void {
  const consumedId = useRef<number | null>(null);

  useEffect(() => {
    if (!prefill || consumedId.current === prefill.id) return;
    if (!expectedOwnerId || composerOwnerId !== expectedOwnerId) return;
    if (useCourseRefsStore.getState().ownerSessionId !== expectedOwnerId) return;
    // Same exclusion as the user's @course picker: a generation run may still
    // be writing this course by the time the owner finishes attaching.
    if (navigation?.generatingCourseIds?.has(prefill.courseId)) return;

    if (!canApplyWorkbenchComposerPrefill(draft)) {
      consumedId.current = prefill.id;
      onConsumed?.(prefill.id);
      toast.info(t('workbench.interactiveRepair.draftOccupied'));
      return;
    }

    const course = navigation?.lookupCourse(prefill.courseId);
    const ref = makeCourseRef(prefill.courseId, course?.name ?? untitledCourse);
    if (!ref) return;

    useCourseRefsStore.getState().add(ref);
    replaceDraft(prefill.text);
    consumedId.current = prefill.id;
    onConsumed?.(prefill.id);
  }, [
    prefill,
    composerOwnerId,
    expectedOwnerId,
    draft,
    navigation,
    replaceDraft,
    onConsumed,
    t,
    untitledCourse,
  ]);
}
