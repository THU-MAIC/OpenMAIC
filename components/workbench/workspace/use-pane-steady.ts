'use client';

import { useEffect, useState } from 'react';

/** The opening animation (`.ws-pane-enter`, 400ms), plus its stagger. */
export const PANE_ENTER_MS = 500;

/**
 * Whether the right column has been on screen long enough that its opening has played.
 *
 * Its tabs are separate elements (a course, the request preview) that show and hide,
 * and a CSS animation restarts each time an element is shown, so the opening would
 * replay on every tab switch. The animation belongs to the column, not to the tab, so
 * this tracks the column: it goes steady after the opening, and off when the column
 * goes away, for the next opening to play.
 */
export function usePaneSteady(columnOpen: boolean): boolean {
  const [steady, setSteady] = useState(false);
  useEffect(() => {
    if (!columnOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the next opening must find it off
      setSteady(false);
      return;
    }
    const timer = window.setTimeout(() => setSteady(true), PANE_ENTER_MS);
    return () => window.clearTimeout(timer);
  }, [columnOpen]);
  return steady;
}
