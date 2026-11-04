'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Learner-wide V3 completion is authoritative; drafting defers this visit's auto-entry. */
export function useWorkbenchOnboarding({
  root,
  studyId,
  autoStart,
  completed,
  ready,
  available = ready,
  blocked,
  hasDraft = false,
}: {
  root: RefObject<HTMLElement | null>;
  studyId?: string;
  autoStart: boolean;
  completed: boolean;
  ready: boolean;
  available?: boolean;
  blocked: boolean;
  hasDraft?: boolean;
}) {
  const [openStudy, setOpenStudy] = useState<string | null>(null);
  // A local dismissal stays closed this visit while its optional receipt is pending or fails.
  const [finishedStudy, setFinishedStudy] = useState<string | null>(null);
  const unavailable = blocked || !available;
  const [previousUnavailable, setPreviousUnavailable] = useState(unavailable);
  if (unavailable !== previousUnavailable) {
    setPreviousUnavailable(unavailable);
    if (unavailable) setOpenStudy(null);
  }
  const returnFocus = useRef<HTMLElement | null>(null);
  const deferredStudy = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const element = root.current;
    const editable =
      'input:not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly]), [contenteditable="true"]';
    const defer = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          event.type === 'focusin' ? editable : 'input, textarea, [contenteditable="true"]',
        )
      )
        deferredStudy.current = studyId;
    };
    if (element?.contains(document.activeElement) && document.activeElement?.matches(editable))
      deferredStudy.current = studyId;
    element?.addEventListener('focusin', defer, true);
    element?.addEventListener('keydown', defer, true);
    element?.addEventListener('beforeinput', defer, true);
    element?.addEventListener('input', defer, true);
    element?.addEventListener('compositionstart', defer, true);
    return () => {
      element?.removeEventListener('focusin', defer, true);
      element?.removeEventListener('keydown', defer, true);
      element?.removeEventListener('beforeinput', defer, true);
      element?.removeEventListener('input', defer, true);
      element?.removeEventListener('compositionstart', defer, true);
    };
  }, [root, studyId]);
  const active = !!studyId && openStudy === studyId && !unavailable;
  useLayoutEffect(() => {
    if (hasDraft) deferredStudy.current = studyId;
    if (
      !autoStart ||
      completed ||
      !ready ||
      !studyId ||
      blocked ||
      hasDraft ||
      deferredStudy.current === studyId ||
      finishedStudy === studyId ||
      openStudy === studyId
    )
      return;
    // Atomic loading-to-guide handoff before paint, including recovery of an unfinished guide.
    returnFocus.current = root.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Modal ownership must transfer before paint.
    setOpenStudy(studyId);
  }, [autoStart, completed, ready, studyId, blocked, hasDraft, finishedStudy, openStudy, root]);
  const replay = () => {
    if (!studyId || !ready || blocked) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : root.current;
    setOpenStudy(studyId);
  };
  const close = () => {
    // Close locally even if the optional server receipt fails or stalls.
    setFinishedStudy(studyId ?? null);
    setOpenStudy(null);
  };
  return { active, replay, close, returnFocus };
}
