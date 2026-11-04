import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.preview((await context.params).id, (await sandboxBody(request)).port),
  );
}
export function DELETE(request: Request, context: Context) {
  return sandboxRoute(request, async (service) =>
    service.revokePreviews((await context.params).id),
  );
}
