import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import {
  createOwnerRecoveryCode,
  resolveRequestOwnerId,
  restoreRequestOwnerId,
} from '@/lib/server/agent-runtime/owner';
import { isSameOriginTeacherRequest } from '@/lib/server/teacher/request-origin';

export const runtime = 'nodejs';

function privateHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
}

function jsonError(status: number, code: string, message: string, headers: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export async function GET(req: Request): Promise<Response> {
  const headers = privateHeaders();
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404, headers });
  if (!isSameOriginTeacherRequest(req, { requireBrowserEvidence: true })) {
    return jsonError(403, 'IDENTITY_ORIGIN_INVALID', 'A same-origin request is required', headers);
  }

  const ownerId = resolveRequestOwnerId(req, headers);
  return Response.json({ recoveryCode: createOwnerRecoveryCode(ownerId) }, { headers });
}

export async function POST(req: Request): Promise<Response> {
  const headers = privateHeaders();
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404, headers });
  if (!isSameOriginTeacherRequest(req, { requireOrigin: true })) {
    return jsonError(403, 'IDENTITY_ORIGIN_INVALID', 'A same-origin request is required', headers);
  }
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return jsonError(415, 'IDENTITY_BODY_INVALID', 'The request body must be JSON', headers);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'IDENTITY_BODY_INVALID', 'The request body must be JSON', headers);
  }
  const code =
    body && typeof body === 'object' && !Array.isArray(body) && 'recoveryCode' in body
      ? body.recoveryCode
      : undefined;
  if (!restoreRequestOwnerId(req, headers, code)) {
    return jsonError(400, 'IDENTITY_RECOVERY_INVALID', 'The recovery code is invalid', headers);
  }

  return Response.json({ restored: true }, { headers });
}
