'use client';

/**
 * Run narration adoption once per course load, on whichever classroom surface
 * is mounted.
 *
 * There are two of them -- the standalone classroom page and the workbench
 * pane -- and they carry near-duplicate load and resume effects. Media adoption
 * is unaffected by that duplication because it lives inside the generation
 * pass both surfaces call; narration adoption has no such host, so it lives
 * here, in one hook both mount. A course opened only through the workbench pane
 * would otherwise converge its images and never its narration.
 *
 * The hook owns the course's cancellation. Leaving the course (a switch, an
 * unmount) aborts the loop between clips, so the remaining allocations are
 * never made and the departed course's document lock is never taken for them.
 */
import { useEffect, useRef } from 'react';

import { createLogger } from '@/lib/logger';

import { adoptCachedNarration } from './adopt-cached-narration';

const log = createLogger('NarrationAdoption');

export interface NarrationAdoptionGate {
  /** The load has settled: the store holds this course's scenes. */
  readonly ready: boolean;
  /** The ownership answer. Fails closed, so `false` while unresolved. */
  readonly mayGenerate: boolean;
}

export function useNarrationAdoption(
  stageId: string | undefined,
  { ready, mayGenerate }: NarrationAdoptionGate,
): void {
  // Latched per course, and deliberately NOT latched while ownership is
  // unresolved: the effect re-runs and adopts once the sidecar's answer
  // arrives, the same way the resume effects do.
  const adoptedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!stageId || !ready || !mayGenerate) return;
    if (adoptedRef.current === stageId) return;
    adoptedRef.current = stageId;

    const controller = new AbortController();
    void adoptCachedNarration(stageId, controller.signal).catch((error: unknown) => {
      log.warn('[Classroom] Narration adoption error:', error);
    });
    return () => {
      // Leaving the course aborts the loop, which may have clips left. The
      // latch has to go with it, or returning to this course — on a surface
      // that stays mounted across a switch, which the workbench pane does —
      // would skip the ones the abort cut off. Re-entering a course whose
      // adoption did finish costs a scan that finds nothing to do, because
      // every converted action now carries an allocated id.
      controller.abort();
      if (adoptedRef.current === stageId) adoptedRef.current = undefined;
    };
  }, [stageId, ready, mayGenerate]);
}
