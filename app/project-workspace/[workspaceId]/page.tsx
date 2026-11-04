import { sandboxWorkspaceEnabled } from '@/lib/server/sandbox/settings';
import { notFound } from 'next/navigation';
import { ProjectWorkspace } from '@/components/sandbox/project-workspace';
export const dynamic = 'force-dynamic';
export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  if (!(await sandboxWorkspaceEnabled()) || !/^[A-Za-z0-9._:-]{1,128}$/.test(workspaceId))
    notFound();
  return <ProjectWorkspace key={workspaceId} workspaceId={workspaceId} />;
}
