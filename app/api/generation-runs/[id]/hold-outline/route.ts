/**
 *   POST /api/generation-runs/:id/hold-outline
 *     `{ commandId }`: hold a `countdown` run's outline for review. The run
 *     becomes a `wait` one: it waits for `confirm-outline` instead of
 *     confirming the outline itself at its deadline. Valid until the outline
 *     is confirmed (while it is generated, and while it waits for its
 *     deadline); a `wait` run answers as it is. 409 `RUN_STATE_CONFLICT` once
 *     the outline was confirmed, or for an `auto` run. Idempotent by
 *     `commandId`: a repeated command answers what the first one did.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import {
  ownerApiError,
  ownerNotFound,
  withOwnerResponseHeaders,
} from '@/lib/server/agent-runtime/route-response';
import {
  MAX_COMMAND_BODY_BYTES,
  parseHoldOutline,
  readJsonBody,
} from '@/lib/server/generation/run/input';
import {
  holdGenerationRunOutline,
  isRunId,
  RunCommandConflictError,
} from '@/lib/server/generation/run/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    if (!isRunId(id)) return ownerNotFound(responseHeaders);
    const body = await readJsonBody(req, MAX_COMMAND_BODY_BYTES);
    if (!body.ok) {
      return ownerApiError('INVALID_REQUEST', body.status, body.message, responseHeaders);
    }
    const parsed = parseHoldOutline(body.value);
    if (!parsed.ok) return ownerApiError('INVALID_REQUEST', 400, parsed.message, responseHeaders);
    try {
      const result = await holdGenerationRunOutline(id, ownerId, parsed.value);
      if (!result) return ownerNotFound(responseHeaders);
      return withOwnerResponseHeaders(apiSuccess({ ...result }), responseHeaders);
    } catch (error) {
      if (error instanceof RunCommandConflictError) {
        return ownerApiError('RUN_STATE_CONFLICT', 409, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
