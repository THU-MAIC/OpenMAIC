import { capBodyStream } from '@/lib/server/capped-stream';
import { verifyGatewayRequest } from '@/lib/server/sandbox/preview';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxError } from '@/lib/sandbox/errors';
export const runtime = 'nodejs';
/** Machine-only endpoint. The gateway authenticates separately from a browser's owner cookie. */
export async function POST(request: Request) {
  const headers = { 'cache-control': 'no-store' };
  let body: { ticket: string; host: string; activity?: true };
  try {
    if (!request.body) return new Response(null, { status: 403, headers });
    const capped = capBodyStream(request.body, 8192);
    const text = await new Response(capped.stream).text();
    if (
      capped.exceeded() ||
      !verifyGatewayRequest(text, request.headers.get('x-openmaic-preview-gateway'))
    )
      return new Response(null, { status: 403, headers });
    body = JSON.parse(text);
    if (
      typeof body.ticket !== 'string' ||
      typeof body.host !== 'string' ||
      (body.activity !== undefined && body.activity !== true)
    )
      return new Response(null, { status: 403, headers });
  } catch {
    return new Response(null, { status: 403, headers });
  }
  try {
    return Response.json(
      await SandboxService.previewTarget(body.ticket, body.host, body.activity === true),
      { headers },
    );
  } catch (error) {
    // Denied/revoked grants remain terminal; infrastructure failures are retryable.
    const status =
      error instanceof SandboxError
        ? error.status >= 500 || error.status === 429
          ? error.status
          : 403
        : 503;
    return new Response(null, { status, headers });
  }
}
