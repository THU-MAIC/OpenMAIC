/**
 * `/` — the home page.
 *
 * With the workbench entry on, the home page is the workspace itself: the same
 * shell `/workspace` renders, entered with the sidebar folded (see
 * `defaultNavCollapsed`). With it off — the default — the classic home stays
 * exactly as it was, every option on it included.
 *
 * The decision is the server-side gate `/workspace` already uses, so the two
 * routes cannot disagree: a disabled `/workspace` redirects here and lands on
 * the classic home rather than looping. The gate is read per request because
 * the root layout reads the request's cookies and headers, which already makes
 * every page dynamic.
 *
 * The workspace keeps its own URLs: once something is open the shell mirrors
 * it to `/workspace?…`, so existing deep links and their query keep working.
 */
import { Suspense } from 'react';
import { isWorkbenchEntryEnabled } from '@/lib/workbench/entry-gate';
import { WorkspaceEntry } from '@/components/workbench/WorkspaceEntry';
import { ClassicHomePage } from './classic-home';

export default function Page() {
  if (!isWorkbenchEntryEnabled()) return <ClassicHomePage />;

  return (
    <Suspense fallback={null}>
      <WorkspaceEntry />
    </Suspense>
  );
}
