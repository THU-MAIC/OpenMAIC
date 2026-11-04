import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    return service.grantSession(
      (await context.params).id,
      body.sessionId,
      body.allowWrites,
      body.allowCommands,
    );
  });
}
export function DELETE(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    await service.get((await context.params).id);
    const body = await sandboxBody(request);
    if (typeof body.sessionId !== 'string') throw sandboxInvalid('Session ID is required.');
    return service.revokeSession(body.sessionId);
  });
}
