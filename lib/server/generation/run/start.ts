/**
 * Starting a run, shared by `POST /api/generation-runs` and the headless
 * `POST /api/generate-classroom`: the checks a run must pass before it exists,
 * the create under the owner's limits, and the runner's wake-up.
 */
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import { MODEL_SLOTS, type SlotId } from '@/lib/config/model-slots';
import type { ApiErrorCode } from '@/lib/server/api-response';
import { resolveAgentsForOwner, UnknownAgentsError } from '@/lib/server/agents/registry';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import { clipVoice } from '@/lib/server/generation/run/narration-voice';
import { pickNarratorAgent } from '@/lib/audio/agent-voice-options';
import type { TTSProviderId } from '@/lib/audio/types';
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
import {
  resolveMediaSlot,
  WorkspaceEndpointError,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';

import { generationRunConfig } from './config';
import { wakeGenerationRunner } from './runner';
import {
  ActiveRunLimitError,
  createGenerationRun,
  WaitingRunLimitError,
  type StoredRun,
} from './store';
import type { GenerationRunInput } from './types';

export const GENERATION_MODEL_SLOTS: readonly SlotId[] = [
  ...MODEL_SLOTS.filter((slot) => slot.id.startsWith('course.')).map((slot) => slot.id as SlotId),
  'image',
  'video',
  'tts',
  'webSearch',
];

/** A start refused for a reason the caller can act on; the message is caller-facing. */
export interface StartRefusal {
  code: ApiErrorCode;
  status: number;
  message: string;
  /** Headers the refusal carries (a host's refusal may set them). */
  headers?: Headers;
}

export const QWEN_VOICE_SETTINGS_URL = '/?settings=tts';

export class QwenVoiceRecloneRequiredError extends Error {
  readonly code = 'QWEN_VC_RECLONE_REQUIRED';
  readonly status = 400;
  readonly settingsUrl = QWEN_VOICE_SETTINGS_URL;

  constructor(
    readonly voiceName: string,
    readonly agentName?: string,
  ) {
    super(
      agentName
        ? `Voice "${voiceName}" bound to narrator "${agentName}" is incompatible with the current clone target. ` +
            `Change that agent's voice in Settings before starting generation: ${QWEN_VOICE_SETTINGS_URL} ` +
            `If TTS Settings are unavailable, contact your administrator.`
        : `Saved voice "${voiceName}" is incompatible with the current clone target. ` +
            `Re-clone it in Settings before starting generation: ${QWEN_VOICE_SETTINGS_URL} ` +
            `If TTS Settings are unavailable, contact your administrator.`,
    );
    this.name = 'QwenVoiceRecloneRequiredError';
  }
}

export interface NarratorVoiceCandidate {
  providerId: string;
  voiceId: string;
  name?: string;
  agentName?: string;
}

export function assertNarratorVoiceCompatibility(
  candidates: readonly NarratorVoiceCandidate[],
  configuredVoices: readonly { id: string }[] | undefined,
): void {
  for (const candidate of candidates) {
    try {
      getVoiceRegistrationAdapter(candidate.providerId)?.assertVoiceCompatible?.(
        candidate.voiceId,
        configuredVoices,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'QWEN_VC_RECLONE_REQUIRED') {
        throw new QwenVoiceRecloneRequiredError(
          candidate.name?.trim() || candidate.voiceId,
          candidate.agentName?.trim() || undefined,
        );
      }
      throw error;
    }
  }
}

async function validateQwenNarratorVoices(
  ownerId: string,
  input: GenerationRunInput,
  agents: Awaited<ReturnType<typeof resolveAgentsForOwner>>,
): Promise<void> {
  let connection: MediaConnection;
  try {
    connection = await resolveMediaSlot('tts', {
      workspaceId: await backgroundWorkspaceId(ownerId),
    });
  } catch (error) {
    if (error instanceof SlotDisabledError || error instanceof SlotUnassignedError) return;
    throw error;
  }
  const narrator = pickNarratorAgent(agents);
  const chosen = clipVoice({
    target: {
      connection,
      providerId: connection.providerId as TTSProviderId,
      modelId: connection.modelId,
    },
    preference: input.voice,
    bound: narrator?.voiceConfig,
    unavailable: new Set(),
  })?.voice;
  if (!chosen) return;
  assertNarratorVoiceCompatibility(
    [
      {
        providerId: chosen.providerId,
        voiceId: chosen.voiceId,
        name: narrator?.voiceConfig ? narrator.name : input.voice?.name,
        agentName:
          narrator?.voiceConfig?.providerId === chosen.providerId &&
          narrator.voiceConfig.voiceId === chosen.voiceId
            ? narrator.name
            : undefined,
      },
    ],
    connection.voices,
  );
}

/** The refusal `error` (thrown by {@link startGenerationRun}) answers with, or null for a fault. */
export function startRefusal(error: unknown): StartRefusal | null {
  if (error instanceof ModelAuthorizationError)
    return { code: error.code, status: error.httpStatus, message: error.message };
  if (error instanceof ClassroomMaterialsRejectedError || error instanceof UnknownAgentsError) {
    return { code: 'INVALID_REQUEST', status: 400, message: error.message };
  }
  if (error instanceof QwenVoiceRecloneRequiredError) {
    return { code: error.code, status: error.status, message: error.message };
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
  const agentIds =
    input.agents.mode === 'preset' ? input.agents.agentIds : (input.agents.presetAgentIds ?? []);
  const agents = agentIds.length > 0 ? await resolveAgentsForOwner(ownerId, agentIds) : [];
  await validateQwenNarratorVoices(ownerId, input, agents);
  await assertWorkspaceModelsAuthorized(ownerId, GENERATION_MODEL_SLOTS);
  if (input.materialIds.length > 0) {
    await resolveClassroomMaterials(ownerId, input.materialIds, { forward: false });
  }

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
