'use client';

/**
 * Client-owned navigation for the Pro workspace panes.
 *
 * `session` and `course` describe view state inside one already-mounted
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

export interface WorkspacePaneNavigation {
  readonly panes: WorkspacePanes;
  readonly push: (next: WorkspacePanes) => void;
  readonly replace: (next: WorkspacePanes) => void;
}

export function useWorkspacePaneNavigation(initialPanes: WorkspacePanes): WorkspacePaneNavigation {
  const [panes, setPanes] = useState(initialPanes);
  const panesRef = useRef(initialPanes);

  const commit = useCallback((next: WorkspacePanes, mode: 'push' | 'replace') => {
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
  return useMemo(() => ({ panes, push, replace }), [panes, push, replace]);
}
