/**
 *   POST /api/generation-runs/:id/retry
 *     `{ commandId }`: re-run the step a paused run stopped at (409
 *     `RUN_STATE_CONFLICT` for a run that is not paused). Idempotent by
 *     `commandId`.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import {
  ownerApiError,
  ownerNotFound,
  withOwnerResponseHeaders,
} from '@/lib/server/agent-runtime/route-response';
import { parseCommandId } from '@/lib/server/generation/run/input';
import { wakeGenerationRunner } from '@/lib/server/generation/run/runner';
import {
  isRunId,
  retryGenerationRun,
  RunCommandConflictError,
} from '@/lib/server/generation/run/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    if (!isRunId(id)) return ownerNotFound(responseHeaders);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return ownerApiError('INVALID_REQUEST', 400, 'Invalid JSON body', responseHeaders);
    }
    const commandId = parseCommandId((raw as { commandId?: unknown } | null)?.commandId);
    if (!commandId.ok) {
      return ownerApiError('INVALID_REQUEST', 400, commandId.message, responseHeaders);
    }
    try {
      const result = await retryGenerationRun(id, ownerId, { commandId: commandId.value });
      if (!result) return ownerNotFound(responseHeaders);
      wakeGenerationRunner();
      return withOwnerResponseHeaders(apiSuccess({ ...result }), responseHeaders);
    } catch (error) {
      if (error instanceof RunCommandConflictError) {
        return ownerApiError('RUN_STATE_CONFLICT', 409, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
