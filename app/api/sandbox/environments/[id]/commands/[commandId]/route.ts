import { sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; commandId: string }> };

export function GET(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, commandId } = await context.params;
    return service.command(id, commandId);
  });
}

export function DELETE(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, commandId } = await context.params;
    return service.cancelCommand(id, commandId);
  });
}
