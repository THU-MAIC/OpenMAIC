/**
 * Scene Actions Generation API
 *
 * Generates actions for a scene given its outline and content,
 * then assembles the complete Scene object (the scene actions step,
 * lib/server/generation/steps/scene-actions.ts).
 * This is the second half of the two-step scene generation pipeline.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateSceneActions,
  type SceneActionsInput,
} from '@/lib/server/generation/steps/scene-actions';

const log = createLogger('Scene Actions API');

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();
    const {
      outline,
      allOutlines,
      content,
      stageId,
      agents,
      previousSpeeches,
      userProfile,
      languageDirective,
    } = body as Omit<SceneActionsInput, 'model'>;

    // Validate required fields
    if (!outline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!content) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'content is required');
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    // ── Model resolution from request headers/body ──
    const model = await resolveModelFromRequest(req, body, 'scene-actions');
    outlineTitle = outline?.title;
    resolvedModelString = model.modelString;

    const result = await generateSceneActions(
      {
        outline,
        allOutlines,
        content,
        stageId,
        agents,
        previousSpeeches,
        userProfile,
        languageDirective,
        model,
      },
      { log },
    );
    return apiSuccess({ scene: result.scene, previousSpeeches: result.previousSpeeches });
  } catch (error) {
    if (error instanceof StepRefusal) return apiError('GENERATION_FAILED', 500, error.message);
    log.error(
      `Scene actions generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
}
