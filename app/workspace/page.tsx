/**
 * `/workspace` — the Pro workspace home.
 *
 * Pro mode used to be a `useState` on `app/page.tsx`, which meant the global
 * `SiteHeader` could not know about it and stacked a second navigation bar on
 * top of the workspace's own sidebar. As a route it is addressable instead:
 * `AppChrome` suppresses the header by path prefix, a refresh keeps you here,
 * and the workspace can be linked to.
 *
 * The gate is server-side and checks the pair of workbench flags:
 * `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` (build-time, client-visible) and
 * the server-only configured runtime truth. A workspace whose
 * every submit 404s is worse than no workspace, so either flag off redirects
 * to `/` rather than rendering. `/` hides its Pro badge behind the same pair,
 * learned through the `/api/agent/runtime` probe (the client cannot read the
 * server flag), so the entry and the destination agree.
 *
 * `force-dynamic` keeps the flags request-scoped instead of baking them into a
 * prerender.
 *
 * The Suspense boundary covers the route seam that reads the initial deep-link
 * snapshot from `useSearchParams`. Once mounted, the workspace owns pane state
 * locally and mirrors it with the History API, so ordinary pane changes do not
 * ask the server route to render again.
 *
 */
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { isWorkbenchEntryEnabled } from '@/lib/workbench/entry-gate';
import { WorkspaceEntry } from '@/components/workbench/WorkspaceEntry';

export const dynamic = 'force-dynamic';

export default function WorkspacePage() {
  if (!isWorkbenchEntryEnabled()) redirect('/');

  return (
    <Suspense fallback={null}>
      <WorkspaceEntry />
    </Suspense>
  );
}
