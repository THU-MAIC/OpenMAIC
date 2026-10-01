/**
 * Server-side course generation runs (RFC #1754 §E).
 *
 *   POST /api/generation-runs
 *     Start a run: `{ requirement, materialIds?, interactive?, taskEngine?,
 *     agents?, learnerProfile?, outlineReview?, voice? }`. No keys and no
 *     models: the owner's capability slots decide. 202 with the run's
 *     snapshot; 429 `ACTIVE_RUN_LIMIT` when the owner already has the
 *     configured number of active runs.
 *
 *   GET /api/generation-runs?active=1
 *     The owner's active runs (every state but completed and ended), for
 *     course cards.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { resolveAgentsForOwner, UnknownAgentError } from '@/lib/server/agents/registry';
import {
  ClassroomMaterialsRejectedError,
  resolveClassroomMaterials,
} from '@/lib/server/classroom-materials';
import { generationRunConfig } from '@/lib/server/generation/run/config';
import { parseRunInput } from '@/lib/server/generation/run/input';
import { wakeGenerationRunner } from '@/lib/server/generation/run/runner';
import {
  ActiveRunLimitError,
  createGenerationRun,
  listActiveGenerationRuns,
  runSnapshot,
} from '@/lib/server/generation/run/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { WorkspaceEndpointError } from '@/lib/server/model-config/media';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationRuns API');

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return ownerApiError('INVALID_REQUEST', 400, 'Invalid JSON body', responseHeaders);
    }
    const parsed = parseRunInput(raw);
    if (!parsed.ok) return ownerApiError('INVALID_REQUEST', 400, parsed.message, responseHeaders);
    const input = parsed.value;

    try {
      // Checked up front so a run never fails late for these reasons; the
      // material-analysis step checks the materials again.
      if (input.materialIds.length > 0) {
        await resolveClassroomMaterials(ownerId, input.materialIds, { forward: false });
      }
      if (input.agents.mode === 'preset') {
        await resolveAgentsForOwner(ownerId, input.agents.agentIds);
      }
    } catch (error) {
      if (error instanceof ClassroomMaterialsRejectedError || error instanceof UnknownAgentError) {
        return ownerApiError('INVALID_REQUEST', 400, error.message, responseHeaders);
      }
      if (error instanceof WorkspaceEndpointError) {
        return ownerApiError('INVALID_URL', 403, error.message, responseHeaders);
      }
      throw error;
    }

    try {
      const run = await createGenerationRun(ownerId, input, {
        maxActiveRunsPerOwner: generationRunConfig().maxActiveRunsPerOwner,
      });
      wakeGenerationRunner();
      return withOwnerResponseHeaders(apiSuccess({ run: runSnapshot(run) }, 202), responseHeaders);
    } catch (error) {
      if (error instanceof ActiveRunLimitError) {
        return ownerApiError('ACTIVE_RUN_LIMIT', 429, error.message, responseHeaders);
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
    return withOwnerResponseHeaders(apiSuccess({ runs: runs.map(runSnapshot) }), responseHeaders);
  });
}
