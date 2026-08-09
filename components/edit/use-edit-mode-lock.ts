'use client';

import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LOCK_HEARTBEAT_MS,
  refreshEditLock,
  releaseEditLock,
  tryAcquireEditLock,
} from '@/lib/edit/edit-mode-lock';

export interface EditModeLock {
  /**
   * Try to take the cross-tab edit lock. Returns false (and opens the
   * conflict prompt) when another tab is editing this course — the caller
   * must NOT enter edit mode on false.
   */
  readonly acquire: () => boolean;
  /** Release the lock if we still hold it (called when leaving edit mode). */
  readonly release: () => void;
  readonly conflictOpen: boolean;
  readonly dismissConflict: () => void;
}

/**
 * React lifecycle wrapper around the #571 `edit-mode-lock` primitives:
 * a stable per-session tabId, a heartbeat while held, and release on
 * unmount / tab close. When there is no course identity it degrades to
 * single-tab semantics (never refuses entry).
 */
export function useEditModeLock(courseId: string | null | undefined): EditModeLock {
  // Stable per mount; lazy init avoids reading a ref during render.
  const [tabId] = useState(() => nanoid());
  const heldRef = useRef(false);
  const [conflictOpen, setConflictOpen] = useState(false);

  const acquire = useCallback(() => {
    if (!courseId) return true;
    if (!tryAcquireEditLock(courseId, tabId)) {
      setConflictOpen(true);
      return false;
    }
    heldRef.current = true;
    return true;
  }, [courseId, tabId]);

  const release = useCallback(() => {
    if (!courseId || !heldRef.current) return;
    heldRef.current = false;
    releaseEditLock(courseId, tabId);
  }, [courseId, tabId]);

  useEffect(() => {
    if (!courseId) return;
    const id = setInterval(() => {
      if (heldRef.current) refreshEditLock(courseId, tabId);
    }, LOCK_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [courseId, tabId]);

  useEffect(() => {
    const releaseIfHeld = () => {
      if (courseId && heldRef.current) releaseEditLock(courseId, tabId);
    };
    window.addEventListener('beforeunload', releaseIfHeld);
    return () => {
      window.removeEventListener('beforeunload', releaseIfHeld);
      releaseIfHeld();
    };
  }, [courseId, tabId]);

  const dismissConflict = useCallback(() => setConflictOpen(false), []);

  // Stable identity (callbacks are useCallback'd) so consumers can depend
  // on the returned object without re-running effects every render.
  return useMemo(
    () => ({ acquire, release, conflictOpen, dismissConflict }),
    [acquire, release, conflictOpen, dismissConflict],
  );
}
