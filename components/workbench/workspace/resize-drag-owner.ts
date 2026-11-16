'use client';

/**
 * Who aborts a pane-edge drag still in flight (`trackFoldableResize`) as it
 * unmounts. A handle owns its own drag by default; a handle that may be
 * swapped for another mid-drag (the rail's open and folded edges) is given an
 * owner that outlives the swap, held by the shell.
 */
import { useEffect, useState } from 'react';

/** Holds the drag in flight, if any, for whoever outlives it. */
export interface ResizeDragOwner {
  /** Takes the drag just started. */
  readonly hold: (abort: () => void) => void;
  /** The drag ended on its own. */
  readonly release: (abort: () => void) => void;
  /** Aborts the drag in flight, if any: nothing is committed. */
  readonly abort: () => void;
}

export function createResizeDragOwner(): ResizeDragOwner {
  let current: (() => void) | null = null;
  return {
    hold: (abort) => {
      current = abort;
    },
    release: (abort) => {
      if (current === abort) current = null;
    },
    abort: () => {
      const abort = current;
      current = null;
      abort?.();
    },
  };
}

/** A drag owner that aborts the drag in flight as the calling component unmounts. */
export function useResizeDragOwner(): ResizeDragOwner {
  const [owner] = useState(createResizeDragOwner);
  useEffect(() => () => owner.abort(), [owner]);
  return owner;
}
