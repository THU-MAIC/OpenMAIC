/**
 * Backward-compatible bridge for historical `/workbench/new?prompt=&skill=`
 * links and rolling-deployment sessionStorage handoffs. New launches happen
 * directly inside `/workspace`; this route owns no composer or product UI.
 */
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { isWorkbenchEntryEnabled } from '@/lib/workbench/entry-gate';
import { WorkbenchLaunchBridge } from './client';

export const dynamic = 'force-dynamic';

export default function WorkbenchNewCompatibilityPage() {
  if (!isWorkbenchEntryEnabled()) notFound();

  return (
    <Suspense fallback={null}>
      <WorkbenchLaunchBridge />
    </Suspense>
  );
}
