import 'server-only';
import type { OwnerPrincipal } from '@/lib/server/identity';

import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { capBodyStream } from '@/lib/server/capped-stream';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { SandboxError, sandboxInvalid } from '@/lib/sandbox/errors';

import { SandboxService } from './service';

export async function sandboxBody(
  request: Request,
  limit = 4096,
): Promise<Record<string, unknown>> {
  if (!request.body) throw sandboxInvalid('A JSON object is required.');
  const capped = capBodyStream(request.body, limit);
  let value: unknown;
  try {
    value = JSON.parse(await new Response(capped.stream).text());
  } catch {
    if (capped.exceeded())
      throw new SandboxError('SANDBOX_BODY_TOO_LARGE', 413, 'Request body is too large.');
    throw sandboxInvalid('A JSON object is required.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw sandboxInvalid('A JSON object is required.');
  return value as Record<string, unknown>;
}

/** All sandbox operations need a deliberate same-origin client, including file reads. */
export function sandboxRoute(
  request: Request,
  handle: (service: SandboxService) => Promise<unknown>,
): Promise<Response> {
  return sandboxResponse(request, async (service) =>
    Response.json({ success: true, data: await handle(service) }),
  );
}

/** Streaming transports use the same owner and CSRF boundary as JSON endpoints. */
export function sandboxResponse(
  request: Request,
  handle: (service: SandboxService) => Promise<Response>,
): Promise<Response> {
  return sandboxPrincipalResponse(request, async (principal) =>
    handle(await SandboxService.forOwner(principal)),
  );
}

/** Configuration endpoints use the same identity/CSRF boundary without requiring a configured provider. */
export function sandboxPrincipalResponse(
  request: Request,
  handle: (principal: OwnerPrincipal) => Promise<Response>,
): Promise<Response> {
  return withRequestOwner(request, async (principal, headers) => {
    headers.set('cache-control', 'no-store');
    try {
      if (request.headers.get('x-openmaic-sandbox') !== '1') {
        throw new SandboxError('SANDBOX_CSRF', 403, 'The sandbox request header is required.');
      }
      const site = request.headers.get('sec-fetch-site');
      if (
        (site && site !== 'same-origin') ||
        (request.method !== 'GET' && !isSameOriginJsonRequest(request))
      ) {
        throw new SandboxError('SANDBOX_CSRF', 403, 'Cross-origin sandbox requests are refused.');
      }
      const response = await handle(principal);
      headers.forEach((value, key) => response.headers.set(key, value));
      response.headers.set('x-content-type-options', 'nosniff');
      return response;
    } catch (error) {
      const ownerResponse = ownerWriteErrorResponse(error, headers);
      if (ownerResponse) return ownerResponse;
      if (error instanceof SandboxError) {
        return Response.json(
          {
            success: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.reason ? { reason: error.reason } : {}),
            },
          },
          { status: error.status, headers },
        );
      }
      // No SDK message/cause/stack: signed URLs and provider keys can appear there.
      return Response.json(
        {
          success: false,
          error: {
            code: 'SANDBOX_UNAVAILABLE',
            message:
              'Sandbox operation could not be confirmed. Reconcile state before retrying a mutation.',
          },
        },
        { status: 503, headers },
      );
    }
  });
}
