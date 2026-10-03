/**
 *   POST /api/generation-runs/:id/retry
 *     `{ commandId }`: re-run the step a paused run stopped at (409
 *     `RUN_STATE_CONFLICT` for a run that is not paused; 429 `ACTIVE_RUN_LIMIT`
 *     when the owner already has the limit of runs in progress, since a paused
 *     run does not count and a retried one does).
 *     `{ commandId, media: { elementId } }`: generate one failed image or
 *     video again, in a run that is generating, paused or completed; nothing
 *     else of the run runs again (409 `RUN_STATE_CONFLICT` for an element
 *     that has not failed, or failed for a reason Retry cannot change).
 *     Idempotent by `commandId`.
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
  parseRetry,
  readJsonBody,
} from '@/lib/server/generation/run/input';
import { generationRunConfig } from '@/lib/server/generation/run/config';
import { wakeGenerationRunner } from '@/lib/server/generation/run/runner';
import {
  ActiveRunLimitError,
  isRunId,
  retryGenerationRun,
  RunCommandConflictError,
} from '@/lib/server/generation/run/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { wakeOwnerMaterialExtractor } from '@/lib/server/materials/extractor-wake';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    if (!isRunId(id)) return ownerNotFound(responseHeaders);
    const body = await readJsonBody(req, MAX_COMMAND_BODY_BYTES);
    if (!body.ok) {
      return ownerApiError('INVALID_REQUEST', body.status, body.message, responseHeaders);
    }
    const command = parseRetry(body.value);
    if (!command.ok) {
      return ownerApiError('INVALID_REQUEST', 400, command.message, responseHeaders);
    }
    try {
      const result = await retryGenerationRun(id, ownerId, command.value, {
        maxActiveRunsPerOwner: generationRunConfig().maxActiveRunsPerOwner,
      });
      if (!result) return ownerNotFound(responseHeaders);
      wakeGenerationRunner();
      // A Retry at the materials restarts their failed extractions.
      wakeOwnerMaterialExtractor();
      return withOwnerResponseHeaders(apiSuccess({ ...result }), responseHeaders);
    } catch (error) {
      if (error instanceof RunCommandConflictError) {
        return ownerApiError('RUN_STATE_CONFLICT', 409, error.message, responseHeaders);
      }
      if (error instanceof ActiveRunLimitError) {
        return ownerApiError('ACTIVE_RUN_LIMIT', 429, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
