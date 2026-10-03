/**
 *   POST /api/generation-runs/:id/confirm-outline
 *     `{ outlineRevision, outlines?, commandId }`: confirm the outline the run
 *     waits on, at the revision the caller saw (409 `RUN_STATE_CONFLICT` when
 *     it moved on), optionally replacing it with the caller's edit. The run
 *     then generates the course to completion. Confirming puts the run in
 *     progress again, so the per-owner limit applies (429 `ACTIVE_RUN_LIMIT`). Idempotent by `commandId`: a
 *     repeated command answers what the first one did.
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
  parseConfirmOutline,
  readJsonBody,
} from '@/lib/server/generation/run/input';
import { wakeGenerationRunner } from '@/lib/server/generation/run/runner';
import { generationRunConfig } from '@/lib/server/generation/run/config';
import {
  ActiveRunLimitError,
  confirmGenerationRunOutline,
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
    const raw = body.value;
    const parsed = parseConfirmOutline(raw);
    if (!parsed.ok) return ownerApiError('INVALID_REQUEST', 400, parsed.message, responseHeaders);
    try {
      const result = await confirmGenerationRunOutline(id, ownerId, parsed.value, {
        maxActiveRunsPerOwner: generationRunConfig().maxActiveRunsPerOwner,
      });
      if (!result) return ownerNotFound(responseHeaders);
      wakeGenerationRunner();
      return withOwnerResponseHeaders(apiSuccess({ ...result }), responseHeaders);
    } catch (error) {
      if (error instanceof ActiveRunLimitError) {
        return ownerApiError('ACTIVE_RUN_LIMIT', 429, error.message, responseHeaders);
      }
      if (error instanceof RunCommandConflictError) {
        return ownerApiError('RUN_STATE_CONFLICT', 409, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
