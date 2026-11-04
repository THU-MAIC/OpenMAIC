import { sandboxResponse } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; terminalId: string }> };

export function GET(request: Request, context: Context) {
  return sandboxResponse(request, async (service) => {
    const { id, terminalId } = await context.params;
    return new Response(await service.terminalStream(id, terminalId, request.signal), {
      headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' },
    });
  });
}
