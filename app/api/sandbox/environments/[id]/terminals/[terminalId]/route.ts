import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; terminalId: string }> };

export function GET(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, terminalId } = await context.params;
    return service.terminal(id, terminalId);
  });
}

export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, terminalId } = await context.params;
    return service.updateTerminal(id, terminalId, await sandboxBody(request, 128 * 1024));
  });
}

export function DELETE(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const { id, terminalId } = await context.params;
    return service.closeTerminal(id, terminalId);
  });
}
