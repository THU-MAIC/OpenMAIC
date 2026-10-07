/**
 * Starting a run, shared by `POST /api/generation-runs` and the headless
 * `POST /api/generate-classroom`: the checks a run must pass before it exists,
 * the create under the owner's limits, and the runner's wake-up.
 */
import type { ApiErrorCode } from '@/lib/server/api-response';
import { resolveAgentsForOwner, UnknownAgentsError } from '@/lib/server/agents/registry';
import {
  ClassroomMaterialsRejectedError,
  resolveClassroomMaterials,
} from '@/lib/server/classroom-materials';
import { getGenerationRunHooks } from '@/lib/server/generation-run-hooks/registry';
import {
  authorizeGenerationStart,
  GenerationStartRefusedError,
} from '@/lib/server/generation-run-hooks/runtime';
import type { GenerationStartOrigin } from '@/lib/server/generation-run-hooks/types';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { WorkspaceEndpointError } from '@/lib/server/model-config/media';

import { generationRunConfig } from './config';
import { wakeGenerationRunner } from './runner';
import {
  ActiveRunLimitError,
  createGenerationRun,
  WaitingRunLimitError,
  type StoredRun,
} from './store';
import type { GenerationRunInput } from './types';

/** A start refused for a reason the caller can act on; the message is caller-facing. */
export interface StartRefusal {
  code: ApiErrorCode;
  status: number;
  message: string;
  /** Headers the refusal carries (a host's refusal may set them). */
  headers?: Headers;
}

/** The refusal `error` (thrown by {@link startGenerationRun}) answers with, or null for a fault. */
export function startRefusal(error: unknown): StartRefusal | null {
  if (error instanceof ClassroomMaterialsRejectedError || error instanceof UnknownAgentsError) {
    return { code: 'INVALID_REQUEST', status: 400, message: error.message };
  }
  // A document or speech service this workspace may not use.
  if (error instanceof WorkspaceEndpointError) {
    return { code: 'INVALID_URL', status: 403, message: error.message };
  }
  if (error instanceof ActiveRunLimitError || error instanceof WaitingRunLimitError) {
    return { code: 'ACTIVE_RUN_LIMIT', status: 429, message: error.message };
  }
  // The host's own refusal, with its own code.
  if (error instanceof GenerationStartRefusedError) {
    return {
      code: error.code as ApiErrorCode,
      status: error.status,
      message: error.message,
      headers: error.headers,
    };
  }
  return null;
}

/** The request a start came from, for the host's `authorizeStart`. */
export interface StartRequest {
  principal: OwnerPrincipal;
  request: Request;
  origin: GenerationStartOrigin;
}

/**
 * Create a run of `ownerId` (the request's own owner) and wake the runner.
 * The materials and preset agents are checked up front so a run never fails
 * late for these reasons (the material-analysis step checks the materials
 * again). With `start`, the host's `authorizeStart` admits the run last,
 * after the owner's limits, on the transaction that creates it. Throws what
 * {@link startRefusal} maps, or a fault.
 */
export async function startGenerationRun(
  ownerId: string,
  input: GenerationRunInput,
  start?: StartRequest,
): Promise<StoredRun> {
  if (input.materialIds.length > 0) {
    await resolveClassroomMaterials(ownerId, input.materialIds, { forward: false });
  }
  const agentIds =
    input.agents.mode === 'preset' ? input.agents.agentIds : (input.agents.presetAgentIds ?? []);
  if (agentIds.length > 0) await resolveAgentsForOwner(ownerId, agentIds);

  const config = generationRunConfig();
  const run = await createGenerationRun(ownerId, input, {
    maxActiveRunsPerOwner: config.maxActiveRunsPerOwner,
    maxWaitingRunsPerOwner: config.maxWaitingRunsPerOwner,
    // Asked only when a host registered it: a start is unchanged without.
    ...(start && getGenerationRunHooks().authorizeStart
      ? {
          authorize: (tx, runId) =>
            authorizeGenerationStart({
              runId,
              principal: start.principal,
              ownerId,
              input,
              request: start.request,
              origin: start.origin,
              tx,
            }),
        }
      : {}),
  });
  wakeGenerationRunner();
  return run;
}
