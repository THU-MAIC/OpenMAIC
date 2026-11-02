'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
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
  blocked,
}: {
  root: RefObject<HTMLElement | null>;
  studyId?: string;
  autoStart: boolean;
  ready: boolean;
  blocked: boolean;
}) {
  const [openStudy, setOpenStudy] = useState<string | null>(null);
  const [previousBlocked, setPreviousBlocked] = useState(blocked);
  if (blocked !== previousBlocked) {
    setPreviousBlocked(blocked);
    if (blocked) setOpenStudy(null);
  }
  const attempted = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const active = !!studyId && openStudy === studyId && !blocked;
  useEffect(() => {
    const element = root.current;
    const interacted = () => {
      attempted.current = true;
    };
    element?.addEventListener('pointerdown', interacted, true);
    element?.addEventListener('keydown', interacted, true);
    element?.addEventListener('input', interacted, true);
    return () => {
      element?.removeEventListener('pointerdown', interacted, true);
      element?.removeEventListener('keydown', interacted, true);
      element?.removeEventListener('input', interacted, true);
    };
  }, [root]);
  useEffect(() => {
    if (!autoStart || !ready || !studyId || blocked || attempted.current) return;
    if (hasSeenOnboarding(browserStorage())) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (attempted.current || hasSeenOnboarding(browserStorage())) return;
        attempted.current = true;
        // Automatic entry returns to the current workspace, never an input
        // that could turn the tour's final keystroke into a learner message.
        returnFocus.current = root.current;
        setOpenStudy(studyId);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [autoStart, ready, studyId, blocked, root]);
  const replay = () => {
    if (!studyId || blocked) return;
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
    if (blocked) {
      attempted.current = true;
    }
  }, [blocked]);
  return { active, replay, close, returnFocus };
}
