'use client';

import { useCallback, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';

/** A report that was already available when this workbench opened belongs to history. */
export function useProjectCompletion(
  view: Pick<LearningView, 'id' | 'reportAvailable' | 'busy'> | null,
  { reportOpen, blocked }: { reportOpen: boolean; blocked: boolean },
) {
  const studyId = view?.id;
  const [visit, setVisit] = useState({
    studyId,
    eligible: !!view && !view.reportAvailable,
  });
  if (visit.studyId !== studyId) {
    setVisit({ studyId, eligible: !!view && !view.reportAvailable });
  } else if (reportOpen && visit.eligible) {
    // The learner can open the report from the toolbar while the last reply is still playing.
    setVisit({ studyId, eligible: false });
  }
  const dismiss = useCallback(() => {
    setVisit((current) =>
      current.studyId === studyId && current.eligible ? { studyId, eligible: false } : current,
    );
  }, [studyId]);
  return {
    open: visit.eligible && !!view?.reportAvailable && !view.busy && !reportOpen && !blocked,
    dismiss,
  };
}
