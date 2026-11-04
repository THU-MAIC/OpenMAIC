import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.listCommands((await context.params).id));
}

export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.startCommand((await context.params).id, await sandboxBody(request, 256 * 1024)),
  );
}
