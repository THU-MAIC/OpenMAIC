import { sandboxRoute } from '@/lib/server/sandbox/http';

export const runtime = 'nodejs';

export function GET(request: Request) {
  return sandboxRoute(request, async (service) => service.capabilities());
}
