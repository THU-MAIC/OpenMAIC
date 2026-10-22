import { sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { learningReport } from '@/lib/server/pbl-v3/report';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw sandboxInvalid('A learning session is required.');
    return Response.json(await learningReport(principal, id));
  });
}
