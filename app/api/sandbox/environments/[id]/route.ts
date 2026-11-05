import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** Stored host state only; POST reconcile explicitly consults the provider. */
export function GET(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.get((await context.params).id));
}

export function POST(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    if (body.action === 'renew') return service.renew((await context.params).id);
    if (body.action !== 'reconcile') throw sandboxInvalid('Expected action: reconcile.');
    return service.reconcile((await context.params).id);
  });
}

/** Destructive release; it is deliberately not called stop/pause. */
export function DELETE(request: Request, context: Context) {
  return sandboxRoute(request, async (service) => service.destroy((await context.params).id));
}
