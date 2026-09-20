/**
 * POST /api/claim — the first device asks for a code its second device can use.
 *
 * The code adopts whatever owner identity this request already carries, so the
 * caller is not told who it is and does not have to be: an anonymous visitor
 * gets its cookie minted here, exactly as every other owner-scoped route does.
 */
import { mintClaimCode } from '@/lib/persistence/claim-code';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { apiSuccess } from '@/lib/server/api-response';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(request, responseHeaders);
  const { code, expiresAt } = await mintClaimCode(ownerId);

  const response = apiSuccess({ code, expiresAt });
  // A freshly minted owner cookie has to ride this response, or the device that
  // just asked for a code would come back as a different owner and the code
  // would adopt an identity nobody is using.
  for (const cookie of responseHeaders.getSetCookie()) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
}
