/**
 * POST /api/pbl/v2/evaluate
 *
 * Three-in-one SSE entry point for PBL v2 evaluations. The client
 * picks the kind via the request body:
 *
 *   { kind: 'task', milestoneId, microtaskId, project }
 *   { kind: 'milestone', milestoneId, project }
 *   { kind: 'final', project }
 *
 * Same wire shape as `/api/pbl/v2/instructor`: SSE stream of
 * PBLSSEEvent, ending with a final `done` after a `project_patch`
 * carrying the new PBLEvaluation. Client wraps the evaluation into
 * either a task-eval card (in-chat), a milestone+handover card
 * (chat), or the completion page (separate UI).
 *
 * The route is stateless: the client owns the project clone and
 * sends it in the body. The server mutates the clone and the patch
 * event tells the client what changed. Same pattern as instructor
 * route — see `app/api/pbl/v2/instructor/route.ts`.
 *
 * Why kind-as-body not kind-as-URL: the three runs all need the
 * same model resolution, headers, project decoding, and SSE
 * heartbeat plumbing — keeping them on one route avoids three
 * near-identical handlers. The trade-off is a runtime switch on a
 * string, which is cheap and obvious.
 */

import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import {
  runFinalEvaluation,
  runMilestoneEvaluation,
  runTaskEvaluation,
} from '@/lib/pbl/v2/agents/evaluator';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export const maxDuration = 300;

const log = createLogger('PBL v2 Evaluate API');

type EvalKind = 'task' | 'milestone' | 'final';

interface EvaluateRequest {
  project: PBLProjectV2;
  kind: EvalKind;
  milestoneId?: string;
  microtaskId?: string;
  recentChatSummary?: string;
}

export async function POST(req: NextRequest) {
  let body: EvaluateRequest;
  try {
    body = (await req.json()) as EvaluateRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }
  if (body.kind !== 'task' && body.kind !== 'milestone' && body.kind !== 'final') {
    return apiError('INVALID_REQUEST', 400, "`kind` must be 'task' | 'milestone' | 'final'.");
  }
  if (body.kind === 'task' && (!body.milestoneId || !body.microtaskId)) {
    return apiError(
      'MISSING_REQUIRED_FIELD',
      400,
      "kind='task' requires both milestoneId and microtaskId.",
    );
  }
  if (body.kind === 'milestone' && !body.milestoneId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, "kind='milestone' requires milestoneId.");
  }

  let resolved;
  try {
    resolved = await resolveModelFromRequest(req, body, 'pbl-v2-runtime:evaluate');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }
  const { model, thinkingConfig, modelInfo } = resolved;
  const hasVision = !!modelInfo?.capabilities?.vision;

  if (body.kind === 'task') {
    return createSSEResponse(
      runTaskEvaluation({
        project: body.project,
        milestoneId: body.milestoneId!,
        microtaskId: body.microtaskId!,
        languageModel: model,
        thinkingConfig,
        recentChatSummary: body.recentChatSummary,
        hasVision,
        signal: req.signal,
      }),
      { signal: req.signal },
    );
  }
  if (body.kind === 'milestone') {
    return createSSEResponse(
      runMilestoneEvaluation({
        project: body.project,
        milestoneId: body.milestoneId!,
        languageModel: model,
        thinkingConfig,
        recentChatSummary: body.recentChatSummary,
        signal: req.signal,
      }),
      { signal: req.signal },
    );
  }
  // final
  return createSSEResponse(
    runFinalEvaluation({
      project: body.project,
      languageModel: model,
      thinkingConfig,
      recentChatSummary: body.recentChatSummary,
      signal: req.signal,
    }),
    { signal: req.signal },
  );
}
