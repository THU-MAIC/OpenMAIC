'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { hasSeenOnboarding, rememberOnboarding } from '@/lib/pbl/v3/onboarding';

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useWorkbenchOnboarding({
  root,
  studyId,
  autoStart,
  ready,
  available = ready,
  blocked,
  hasDraft = false,
}: {
  root: RefObject<HTMLElement | null>;
  studyId?: string;
  autoStart: boolean;
  ready: boolean;
  available?: boolean;
  blocked: boolean;
  hasDraft?: boolean;
}) {
  const [openStudy, setOpenStudy] = useState<string | null>(null);
  const unavailable = blocked || !available;
  const [previousUnavailable, setPreviousUnavailable] = useState(unavailable);
  if (unavailable !== previousUnavailable) {
    setPreviousUnavailable(unavailable);
    if (unavailable) setOpenStudy(null);
  }
  const attempted = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const active = !!studyId && openStudy === studyId && !unavailable;
  useEffect(() => {
    const element = root.current;
    const interacted = (event: Event) => {
      // Layout browsing and clicks on disabled controls while connecting do
      // not mean the learner has started work. Actual drafting always does.
      const editing =
        event.target instanceof Element &&
        !!event.target.closest('input, textarea, [contenteditable="true"]');
      if (ready || event.type === 'input' || editing) attempted.current = true;
    };
    element?.addEventListener('pointerdown', interacted, true);
    element?.addEventListener('keydown', interacted, true);
    element?.addEventListener('input', interacted, true);
    return () => {
      element?.removeEventListener('pointerdown', interacted, true);
      element?.removeEventListener('keydown', interacted, true);
      element?.removeEventListener('input', interacted, true);
    };
  }, [root, ready]);
  useLayoutEffect(() => {
    if (!autoStart || !ready || !studyId || blocked || hasDraft || attempted.current) return;
    if (hasSeenOnboarding(browserStorage())) return;
    // layoutReady already guarantees Hero expansion has settled. Open before
    // paint so the entry barrier hands focus directly to the mandatory guide.
    attempted.current = true;
    returnFocus.current = root.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Atomic modal/focus handoff must finish before paint.
    setOpenStudy(studyId);
  }, [autoStart, ready, studyId, blocked, hasDraft, root]);
  const replay = () => {
    if (!studyId || !ready || blocked) return;
    attempted.current = true;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : root.current;
    setOpenStudy(studyId);
  };
  const close = useCallback(() => {
    attempted.current = true;
    rememberOnboarding(browserStorage());
    setOpenStudy(null);
  }, []);
  // An actionable failure takes precedence. It must not reopen the tour once
  // recovery finishes, or be recorded as the learner dismissing it.
  useEffect(() => {
    if (blocked || hasDraft) {
      attempted.current = true;
    }
  }, [blocked, hasDraft]);
  return { active, replay, close, returnFocus };
}
