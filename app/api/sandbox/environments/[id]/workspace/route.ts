import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export function GET(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const id = (await context.params).id;
    const env = await service.get(id);
    return {
      checkpoint: await service.checkpoint(id),
      files: env.state === 'running' && env.workspaceReady ? await service.listFiles(id) : [],
    };
  });
}
export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const id = (await context.params).id;
    const body = await sandboxBody(request);
    if (body.action === 'restore') return service.restoreWorkspace(id);
    if (body.action === 'save' || body.action === 'save-and-release')
      return service.saveWorkspace(id, body.expectedRevision, body.action === 'save-and-release');
    throw sandboxInvalid('Expected save, save-and-release or restore.');
  });
}
