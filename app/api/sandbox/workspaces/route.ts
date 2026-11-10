import { sandboxRoute, sandboxBody } from '@/lib/server/sandbox/http';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return sandboxRoute(request, (service) => service.savedProjects());
}
export function DELETE(request: Request) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    return service.deleteSavedProject(body.workspaceId, body.revision);
  });
}
