import { NextRequest } from 'next/server';

import { settleWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';
import { apiError } from '@/lib/server/api-response';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';

export const runtime = 'nodejs';

const BODY_KEYS = new Set(['queryId', 'stageId', 'visibility']);

function validBody(value: unknown): value is {
  queryId: string;
  stageId: string;
  visibility: 'open' | 'closed';
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Reflect.ownKeys(body).every((key) => typeof key === 'string' && BODY_KEYS.has(key)) &&
    Object.hasOwn(body, 'queryId') &&
    Object.hasOwn(body, 'stageId') &&
    Object.hasOwn(body, 'visibility') &&
    typeof body.queryId === 'string' &&
    body.queryId.length > 0 &&
    typeof body.stageId === 'string' &&
    body.stageId.length > 0 &&
    (body.visibility === 'open' || body.visibility === 'closed')
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  // The pending query is keyed by the learner key the Pi request resolved,
  // which is the request owner; only that owner can settle it.
  const owner = await resolveRequestOwner(req);
  if (!owner.ok) {
    return apiError('INVALID_CREDENTIALS', 401, 'Invalid owner credential');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid whiteboard visibility response');
  }
  if (!validBody(body)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid whiteboard visibility response');
  }

  if (
    !settleWhiteboardVisibility({
      ...body,
      learnerKey: owner.principal.ownerId,
    })
  ) {
    return apiError('INVALID_REQUEST', 404, 'Whiteboard visibility query is not pending here');
  }
  return new Response(null, { status: 204 });
}
