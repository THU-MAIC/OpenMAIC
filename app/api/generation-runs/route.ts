/**
 * Server-side course generation runs (RFC #1754 §E).
 *
 *   POST /api/generation-runs
 *     Start a run: `{ requirement, materialIds?, interactive?, taskEngine?,
 *     agents?, learnerProfile?, outlineReview?, voice? }`. No keys and no
 *     models: the owner's capability slots decide. 202 with the run's
 *     snapshot; 429 `ACTIVE_RUN_LIMIT` when the owner already has the
 *     configured number of runs in progress, or of runs waiting for their
 *     outline to be confirmed. `outlineReview` is `wait` (the default: the
 *     run waits for `confirm-outline`), `countdown` (the run confirms its
 *     outline itself after a short pause, unless `hold-outline` turned it
 *     into a `wait` run first) or `auto` (the outline is confirmed at once).
 *
 *   GET /api/generation-runs?active=1
 *     The owner's active runs (every state but completed and ended), for
 *     course cards, and the owner's `limits` (`maxActive` runs preparing,
 *     outlining or generating; `maxWaiting` runs waiting for confirmation),
 *     so a client can tell before uploading materials that a start would be
 *     refused.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import {
  MAX_START_BODY_BYTES,
  parseRunInput,
  readJsonBody,
} from '@/lib/server/generation/run/input';
import { generationRunConfig } from '@/lib/server/generation/run/config';
import { startGenerationRun, startRefusal } from '@/lib/server/generation/run/start';
import { listActiveGenerationRuns, runSnapshot } from '@/lib/server/generation/run/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationRuns API');

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const body = await readJsonBody(req, MAX_START_BODY_BYTES);
    if (!body.ok) {
      return ownerApiError('INVALID_REQUEST', body.status, body.message, responseHeaders);
    }
    const parsed = parseRunInput(body.value);
    if (!parsed.ok) return ownerApiError('INVALID_REQUEST', 400, parsed.message, responseHeaders);

    try {
      const run = await startGenerationRun(ownerId, parsed.value);
      return withOwnerResponseHeaders(apiSuccess({ run: runSnapshot(run) }, 202), responseHeaders);
    } catch (error) {
      const refusal = startRefusal(error);
      if (refusal) {
        return ownerApiError(refusal.code, refusal.status, refusal.message, responseHeaders);
      }
      log.error('Generation run creation failed:', error);
      return ownerApiError(
        'INTERNAL_ERROR',
        500,
        'Failed to start the generation run',
        responseHeaders,
      );
    }
  });
}

export async function GET(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    if (new URL(req.url).searchParams.get('active') !== '1') {
      return ownerApiError(
        'INVALID_REQUEST',
        400,
        'Only the active runs are listed: pass active=1',
        responseHeaders,
      );
    }
    const runs = await listActiveGenerationRuns(ownerId);
    const config = generationRunConfig();
    return withOwnerResponseHeaders(
      apiSuccess({
        runs: runs.map(runSnapshot),
        limits: {
          maxActive: config.maxActiveRunsPerOwner,
          maxWaiting: config.maxWaitingRunsPerOwner,
        },
      }),
      responseHeaders,
    );
  });
}
