import { sandboxBody, sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';

export function GET(request: Request) {
  return sandboxRoute(request, (service) => service.list());
}

export function POST(request: Request) {
  return sandboxRoute(request, async (service) => {
    const body = await sandboxBody(request);
    return service.create(body.requestId, body.workspaceId, body.profile);
  });
}
