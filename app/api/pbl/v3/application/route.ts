import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { applicationRequest } from '@/lib/server/pbl-v3/application';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) =>
    Response.json(await applicationRequest(principal, await sandboxBody(request))),
  );
}
