'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The server's per-study completion is authoritative; browser/V2 history never exempts entry. */
export function useWorkbenchOnboarding({
  root,
  studyId,
  autoStart,
  completed,
  ready,
  available = ready,
  blocked,
}: {
  root: RefObject<HTMLElement | null>;
  studyId?: string;
  autoStart: boolean;
  completed: boolean;
  ready: boolean;
  available?: boolean;
  blocked: boolean;
}) {
  const [openStudy, setOpenStudy] = useState<string | null>(null);
  // A successful HTTP acknowledgement can precede the next SSE snapshot.
  const [finishedStudy, setFinishedStudy] = useState<string | null>(null);
  const unavailable = blocked || !available;
  const [previousUnavailable, setPreviousUnavailable] = useState(unavailable);
  if (unavailable !== previousUnavailable) {
    setPreviousUnavailable(unavailable);
    if (unavailable) setOpenStudy(null);
  }
  const returnFocus = useRef<HTMLElement | null>(null);
  const active = !!studyId && openStudy === studyId && !unavailable;
  useLayoutEffect(() => {
    if (
      !autoStart ||
      completed ||
      !ready ||
      !studyId ||
      blocked ||
      finishedStudy === studyId ||
      openStudy === studyId
    )
      return;
    // Atomic loading-to-guide handoff before paint, including recovery of an unfinished guide.
    returnFocus.current = root.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Modal ownership must transfer before paint.
    setOpenStudy(studyId);
  }, [autoStart, completed, ready, studyId, blocked, finishedStudy, openStudy, root]);
  const replay = () => {
    if (!studyId || !ready || blocked) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : root.current;
    setOpenStudy(studyId);
  };
  const close = () => {
    // Called only after successful completion persistence, or a completed-study replay.
    setFinishedStudy(studyId ?? null);
    setOpenStudy(null);
  };
  return { active, replay, close, returnFocus };
}
