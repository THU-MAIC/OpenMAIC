'use client';

/**
 * Client-owned navigation for the Pro workspace panes.
 *
 * `session`, `course` and `view` describe view state inside one already-mounted
 * workspace. Sending those changes through Next's router performs an App
 * Router navigation (and can request a fresh RSC payload) even though no
 * server component or route segment changed. This controller keeps the live
 * state in React, mirrors it to the address bar with the native History API,
 * and restores it on browser back/forward.
 *
 * Next patches pushState/replaceState so its own `usePathname` and
 * `useSearchParams` readers stay in sync. The workspace itself deliberately
 * does not subscribe to those readers after its initial deep-link snapshot:
 * otherwise every address-bar mirror would make the route wrapper repaint
 * the whole workbench.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  readWorkspacePanes,
  samePanes,
  workspaceHref,
  type WorkspacePanes,
} from '@/lib/workbench/workspace-panes';

export type WorkspacePaneHistoryMode = 'push' | 'replace';

/** What {@link WorkspacePaneNavigation.update} makes of the panes as they are. */
export type WorkspacePaneUpdate = {
  readonly next: WorkspacePanes;
  readonly mode: WorkspacePaneHistoryMode;
} | null;

export interface WorkspacePaneNavigation {
  readonly panes: WorkspacePanes;
  readonly push: (next: WorkspacePanes) => void;
  readonly replace: (next: WorkspacePanes) => void;
  /**
   * Navigate from the panes as they are when this runs, not as some earlier
   * render saw them. For work that finishes later (a created session, a
   * confirmed deletion) or runs in the background (an agent-created course):
   * both the next panes and the history mode are decided from the current
   * state, so the teacher opening the knowledge base meanwhile is respected.
   * `null` leaves everything as it is.
   */
  readonly update: (decide: (current: WorkspacePanes) => WorkspacePaneUpdate) => void;
}

export function useWorkspacePaneNavigation(initialPanes: WorkspacePanes): WorkspacePaneNavigation {
  const [panes, setPanes] = useState(initialPanes);
  const panesRef = useRef(initialPanes);

  const commit = useCallback((next: WorkspacePanes, mode: WorkspacePaneHistoryMode) => {
    if (samePanes(next, panesRef.current)) return;
    panesRef.current = next;
    setPanes(next);

    const href = workspaceHref(next);
    if (mode === 'push') window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  }, []);

  useEffect(() => {
    const restoreFromHistory = () => {
      const restored = readWorkspacePanes(new URLSearchParams(window.location.search));
      if (samePanes(restored, panesRef.current)) return;
      panesRef.current = restored;
      setPanes(restored);
    };
    window.addEventListener('popstate', restoreFromHistory);
    return () => window.removeEventListener('popstate', restoreFromHistory);
  }, []);

  const push = useCallback((next: WorkspacePanes) => commit(next, 'push'), [commit]);
  const replace = useCallback((next: WorkspacePanes) => commit(next, 'replace'), [commit]);
  const update = useCallback(
    (decide: (current: WorkspacePanes) => WorkspacePaneUpdate) => {
      const decided = decide(panesRef.current);
      if (decided) commit(decided.next, decided.mode);
    },
    [commit],
  );
  return useMemo(() => ({ panes, push, replace, update }), [panes, push, replace, update]);
}
