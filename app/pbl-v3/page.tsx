import { notFound } from 'next/navigation';
import { sandboxWorkspaceEnabled } from '@/lib/server/sandbox/settings';
import PBLExamples from './pbl-examples';
export const dynamic = 'force-dynamic';
export default async function PBLExamplesPage() {
  if (!(await sandboxWorkspaceEnabled())) notFound();
  return <PBLExamples />;
}
