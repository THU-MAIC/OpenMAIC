/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline
 * (the scene content step, lib/server/generation/steps/scene-content.ts).
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 */

import { NextRequest } from 'next/server';
import type { AgentInfo } from '@openmaic/generation';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveVisionImagesForPrompt } from '@/lib/persistence/resolve-vision-images';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { generateSceneContent } from '@/lib/server/generation/steps/scene-content';

const log = createLogger('Scene Content API');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo: _stageInfo,
      stageId,
      agents,
      languageDirective,
      requirements,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: {
        name: string;
        description?: string;
        style?: string;
      };
      stageId: string;
      agents?: AgentInfo[];
      languageDirective?: string;
      requirements?: UserRequirements;
    };

    // Validate required fields
    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    // ── Model resolution from request headers/body ──
    // Route per scene-content type (e.g. `scene-content:quiz`); getStageModel
    // falls back to the base `scene-content` route when the type is unrouted.
    const stage = rawOutline.type ? (`scene-content:${rawOutline.type}` as const) : 'scene-content';
    const model = await resolveModelFromRequest(req, body, stage);
    outlineTitle = rawOutline?.title;
    resolvedModelString = model.modelString;

    const { content, effectiveOutline } = await generateSceneContent(
      {
        outline: rawOutline,
        pdfImages,
        imageMapping,
        agents,
        languageDirective,
        requirements,
        targetLanguage: req.headers?.get('x-user-locale') ?? '',
        model,
      },
      { log, resolveVisionImages: (images) => resolveVisionImagesForPrompt(images, req) },
    );
    return apiSuccess({ content, effectiveOutline });
  } catch (error) {
    if (error instanceof StepRefusal) return apiError('GENERATION_FAILED', 500, error.message);
    log.error(
      `Scene content generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
}
