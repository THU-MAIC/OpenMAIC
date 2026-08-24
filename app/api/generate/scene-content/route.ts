/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
} from '@openmaic/generation';
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
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import { resolveVisionImagesForPrompt } from '@/lib/persistence/resolve-vision-images';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';

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

    const outline: SceneOutline = { ...rawOutline };

    // ── Model resolution from request headers/body ──
    // Route per scene-content type (e.g. `scene-content:quiz`); getStageModel
    // falls back to the base `scene-content` route when the type is unrouted.
    const stage = outline.type ? (`scene-content:${outline.type}` as const) : 'scene-content';
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, stage);
    outlineTitle = rawOutline?.title;
    resolvedModelString = modelString;

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Vision-aware AI call function. On a server-backed transport the
    // `imageMapping` values are allocated asset ids, so the vision srcs reach
    // here as ids; N3 (below) has already filtered `assignedImages` to the
    // resolvable set, so every id this resolution sees succeeds — the
    // resolution drops nothing here, it only turns the surviving ids into the
    // same bytes the base64 path would send (RFC #1153 part 2 B).
    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      images?: Array<{ id: string; src: string }>,
    ): Promise<string> => {
      if (images?.length && hasVision) {
        // Server-backed transport: `imageMapping` values are allocated asset
        // ids, so the image srcs reach here as ids. Resolve them to the same
        // bytes the base64 path would send BEFORE prompt assembly, keeping the
        // vision prompt byte-identical in both modes (RFC #1153 part 2 B).
        const resolvedImages = await resolveVisionImagesForPrompt(images, req.headers);
        const result = await callLLM(
          {
            model: languageModel,
            system: systemPrompt,
            messages: [
              {
                role: 'user' as const,
                content: buildVisionUserContent(userPrompt, resolvedImages),
              },
            ],
            maxOutputTokens: modelInfo?.outputWindow,
            maxRetries: 0,
          },
          'scene-content',
          undefined,
          thinkingConfig,
        );
        return result.text;
      }
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: modelInfo?.outputWindow,
          maxRetries: 0,
        },
        'scene-content',
        undefined,
        thinkingConfig,
      );
      return result.text;
    };

    // ── Apply fallbacks ──
    const vocationalActive = resolveVocationalActive(requirements);
    const effectiveOutline = applyOutlineFallbacks(outline, !!languageModel, {
      allowProceduralSkill: vocationalActive,
    });

    // ── Filter images assigned to this outline ──
    let assignedImages: PdfImage[] | undefined;
    if (
      pdfImages &&
      pdfImages.length > 0 &&
      effectiveOutline.suggestedImageIds &&
      effectiveOutline.suggestedImageIds.length > 0
    ) {
      const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
      assignedImages = sortDocumentImagesForVision(
        pdfImages.filter((img) => suggestedIds.has(img.id)),
      );
    }

    // ── N3: resolve the vision slice BEFORE prompt assembly ──
    // The prompt text and the multimodal attachments must be built from the
    // SAME resolved set: an image the server cannot resolve (a reclaimed
    // asset, a store failure) is dropped from BOTH — its `[see attached]`
    // text mention and its attachment — instead of leaving a dangling promise
    // in the prompt. Per-image: one bad id never aborts the rest; slice order
    // stays stable. The original `imageMapping` (allocated asset ids) is still
    // passed to the generator so `resolveImageIds` writes the ALLOCATED ID
    // into `PPTImageElement.src` (part 2 B) — the pre-resolution only decides
    // which images survive into `assignedImages`; `generateSlideContent` then
    // builds text and `visionImages` from the surviving set, and the aiCall
    // below resolves those ids to bytes for the LLM message.
    if (assignedImages && assignedImages.length > 0 && hasVision && imageMapping) {
      const sorted = sortDocumentImagesForVision(assignedImages);
      const visionSlice = sorted.filter((img) => imageMapping[img.id]).slice(0, MAX_VISION_IMAGES);
      const resolvedVisionImages = await resolveVisionImagesForPrompt(
        visionSlice.map((img) => ({
          id: img.id,
          src: imageMapping[img.id],
          ...(img.width !== undefined ? { width: img.width } : {}),
          ...(img.height !== undefined ? { height: img.height } : {}),
        })),
        req.headers,
      );
      const resolvedIds = new Set(resolvedVisionImages.map((img) => img.id));
      // Drop unresolvable vision images from the assigned set so they produce
      // NO text mention and NO attachment; images never promised an attachment
      // (no mapping entry, or beyond the vision slice) stay as plain
      // descriptions.
      const visionSliceIds = new Set(visionSlice.map((img) => img.id));
      assignedImages = assignedImages.filter(
        (img) => !visionSliceIds.has(img.id) || resolvedIds.has(img.id),
      );
    }

    // ── Media generation is handled client-side in parallel (media-orchestrator.ts) ──
    // The content generator receives placeholder IDs (gen_img_1, gen_vid_1) as-is.
    // resolveImageIds() in generation-pipeline.ts will keep these placeholders in elements.
    const generatedMediaMapping: ImageMapping = {};

    // ── Generate content ──
    log.info(
      `Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
    );

    const userLocale = req.headers?.get('x-user-locale') ?? '';

    const content = await generateSceneContent(effectiveOutline, aiCall, {
      assignedImages,
      imageMapping,
      visionEnabled: hasVision,
      generatedMediaMapping,
      agents,
      languageDirective,
      targetLanguage: userLocale || undefined,
      userRequirements: requirements,
      allowProceduralSkill: vocationalActive,
      ...(effectiveOutline.type === 'pbl'
        ? {
            pblLoopFallback: (input) =>
              generatePBLV2Project(input, languageModel, callLLM, { logger: log }, thinkingConfig),
          }
        : {}),
    });

    if (!content) {
      log.error(`Failed to generate content for: "${effectiveOutline.title}"`);

      return apiError(
        'GENERATION_FAILED',
        500,
        `Failed to generate content: ${effectiveOutline.title}`,
      );
    }

    log.info(`Content generated successfully: "${effectiveOutline.title}"`);

    return apiSuccess({ content, effectiveOutline });
  } catch (error) {
    log.error(
      `Scene content generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
}
