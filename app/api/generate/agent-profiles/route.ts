/**
 * Agent Profiles Generation API
 *
 * Generates agent profiles (teacher, assistant, student) for a course stage
 * based on stage info and scene outlines (the agent profiles step,
 * lib/server/generation/steps/agent-profiles.ts).
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
  type AgentProfilesRefusal,
} from '@/lib/server/generation/steps/agent-profiles';

const log = createLogger('Agent Profiles API');

export const maxDuration = 120;

type RequestBody = Omit<AgentProfilesInput, 'model'>;

const REFUSAL_CODES: Record<AgentProfilesRefusal, ApiErrorCode> = {
  unparseable: 'PARSE_FAILED',
  'too-few-agents': 'GENERATION_FAILED',
  'teacher-count': 'GENERATION_FAILED',
};

export async function POST(req: NextRequest) {
  let stageName: string | undefined;
  let modelString: string | undefined;
  try {
    const body = (await req.json()) as RequestBody;
    const {
      stageInfo,
      sceneOutlines,
      languageDirective,
      availableAvatars,
      avatarDescriptions,
      availableVoices,
      narratorVoice,
    } = body;
    stageName = stageInfo?.name;

    // ── Validate required fields ──
    if (!stageInfo?.name) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageInfo.name is required');
    }
    if (!languageDirective) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'languageDirective is required');
    }
    if (!availableAvatars || availableAvatars.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'availableAvatars is required and must not be empty',
      );
    }

    // ── Model resolution from request headers/body ──
    const model = await resolveModelFromRequest(req, body, 'agent-profiles');
    modelString = model.modelString;

    const agents = await generateAgentProfiles(
      {
        stageInfo,
        sceneOutlines,
        languageDirective,
        availableAvatars,
        avatarDescriptions,
        availableVoices,
        narratorVoice,
        model,
      },
      { log },
    );
    return apiSuccess({ agents });
  } catch (error) {
    if (error instanceof StepRefusal) {
      return apiError(REFUSAL_CODES[error.reason as AgentProfilesRefusal], 500, error.message);
    }
    log.error(
      `Agent profiles generation failed [stage="${stageName ?? 'unknown'}", model=${modelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
