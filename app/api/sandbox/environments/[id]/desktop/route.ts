import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.screenshot((await context.params).id));
}

export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.desktopAction((await context.params).id, await sandboxBody(request, 128 * 1024)),
  );
}
