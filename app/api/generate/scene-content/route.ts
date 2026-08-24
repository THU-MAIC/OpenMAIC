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
  partitionImagesForVision,
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
import {
  resolveVisionImagesForPrompt,
  type VisionPromptImage,
} from '@/lib/persistence/resolve-vision-images';
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
    // `imageMapping` values are allocated asset ids; the N3 pre-resolution
    // below has already resolved the vision slice's ids to bytes and stripped
    // every unresolvable id from the mapping, so the srcs this closure sees
    // are concrete data URLs and this resolution is a DEFENSIVE NO-OP — it
    // passes concrete srcs through untouched (RFC #1153 part 2 B) and would
    // only drop an id that still carried an allocated id, which the
    // pre-resolution makes impossible. Kept so a package consumer that
    // generates without pre-resolving still degrades cleanly.
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

    // ── N3: resolve-then-slice the vision candidates BEFORE prompt assembly ──
    // The prompt text and the multimodal attachments must be built from the
    // SAME resolved set: an image the server cannot resolve (a reclaimed
    // asset, a store failure) is dropped from BOTH — its `[see attached]`
    // text mention and its attachment — instead of leaving a dangling promise
    // in the prompt. The candidates are computed in the generator's OWN order
    // (the shared `partitionImagesForVision` helper, so the route and the
    // generator cannot drift) and resolved IN ORDER with refill until the cap
    // is met or the candidates are exhausted: a drop admits the next image
    // WITH its resolution, so the generator's re-slice (same helper, same
    // cap) can never admit an image this route has not resolved (review P2).
    // Every id the resolution drops is STRIPPED from the `imageMapping` (and
    // `assignedImages`) passed onward, so a model-hallucinated reference to a
    // dropped id takes the existing clean "no mapping → remove element" path
    // in `resolveImageIds` instead of writing a dangling allocated id into
    // `src` (review P3). The resolved slice is passed to the generator so
    // `aiCall` does not re-resolve (its resolution is a defensive no-op).
    let visionImageMapping: ImageMapping | undefined = imageMapping;
    let resolvedVisionImages: VisionPromptImage[] | undefined;
    if (assignedImages && assignedImages.length > 0 && hasVision && imageMapping) {
      const { withSrc } = partitionImagesForVision(assignedImages, imageMapping, MAX_VISION_IMAGES);
      const resolved: VisionPromptImage[] = [];
      const unresolvableIds = new Set<string>();
      for (const candidate of withSrc) {
        if (resolved.length >= MAX_VISION_IMAGES) break;
        const attempted = await resolveVisionImagesForPrompt(
          [
            {
              id: candidate.id,
              src: imageMapping[candidate.id],
              ...(candidate.width !== undefined ? { width: candidate.width } : {}),
              ...(candidate.height !== undefined ? { height: candidate.height } : {}),
            },
          ],
          req.headers,
        );
        if (attempted.length === 1) {
          resolved.push(attempted[0]!);
        } else {
          unresolvableIds.add(candidate.id);
        }
      }
      resolvedVisionImages = resolved;
      if (unresolvableIds.size > 0) {
        assignedImages = assignedImages.filter((img) => !unresolvableIds.has(img.id));
        visionImageMapping = Object.fromEntries(
          Object.entries(imageMapping).filter(([id]) => !unresolvableIds.has(id)),
        );
      }
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
      imageMapping: visionImageMapping,
      visionEnabled: hasVision,
      generatedMediaMapping,
      resolvedVisionImages,
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
