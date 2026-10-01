/**
 * Scene content: generate one scene's content (a slide, quiz, interactive
 * widget or PBL project) from its outline, with the outline's assigned
 * material images attached when the model sees images. Actions are the scene
 * actions step. Moved from POST /api/generate/scene-content, which keeps
 * validating the request and resolving the model for the scene type's stage.
 */
import { callLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent as generateContent,
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
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import type { VisionPromptImage } from '@/lib/persistence/resolve-vision-images';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';

import { StepRefusal, type OwnerStepContext, type StepLanguageModel } from './context';

/**
 * Aggregate budget for the WHOLE resolve-with-refill phase, reused from the
 * shared 15 s ingest-drain constant (the same constant the extraction cache's
 * probe phase reuses). Each probe is an unbounded server-side store round trip
 * (no statement timeout), so an all-fail phase must not churn every candidate
 * sequentially: when the budget expires the phase STOPS and generation
 * proceeds with whatever resolved so far (degrade, never fail).
 */
const VISION_RESOLUTION_BUDGET_MS = 15_000;

/**
 * Consecutive-failure fuse for the resolve-with-refill loop: after this many
 * unresolvable/errored candidates IN A ROW the store is evidently down, so
 * probing stops instead of churning the remaining candidates (one summary warn
 * names the fuse). A resolved candidate resets the streak.
 */
const MAX_CONSECUTIVE_UNRESOLVABLE_VISION_IMAGES = 3;

export interface SceneContentInput {
  outline: SceneOutline;
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  agents?: AgentInfo[];
  languageDirective?: string;
  requirements?: UserRequirements;
  /** The learner's locale, when known. */
  targetLanguage?: string;
  /** The model of the outline type's scene-content stage. */
  model: StepLanguageModel;
}

export type SceneContentRefusal = 'generation-failed';

export type GeneratedSceneContent = NonNullable<Awaited<ReturnType<typeof generateContent>>>;

export interface SceneContentResult {
  content: GeneratedSceneContent;
  /** The outline as generated, after the fallbacks for what it leaves out. */
  effectiveOutline: SceneOutline;
}

export async function generateSceneContent(
  input: SceneContentInput,
  ctx: OwnerStepContext,
): Promise<SceneContentResult> {
  const { pdfImages, imageMapping, agents, languageDirective, requirements } = input;
  const {
    model: languageModel,
    modelInfo,
    modelString,
    thinkingConfig,
    serverManaged,
  } = input.model;
  const { log } = ctx;
  const outline: SceneOutline = { ...input.outline };

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
      const resolvedImages = await ctx.resolveVisionImages(images);
      const result = await callLLM(
        {
          model: languageModel,
          // A run cancels the call when it loses its lease or its course.
          abortSignal: ctx.signal,
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
        { serverManaged },
      );
      return result.text;
    }
    const result = await callLLM(
      {
        model: languageModel,
        abortSignal: ctx.signal,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: modelInfo?.outputWindow,
        maxRetries: 0,
      },
      'scene-content',
      undefined,
      thinkingConfig,
      { serverManaged },
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
  // (the shared `partitionImagesForVision` helper, so the step and the
  // generator cannot drift) and resolved IN ORDER with refill until the cap
  // is met or the candidates are exhausted: a drop admits the next image
  // WITH its resolution, so the generator's re-slice (same helper, same
  // cap) can never admit an image this step has not resolved (review P2).
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
    // Bound the resolve-with-refill loop (review P2, round 3): the store may
    // be down, and each probe is an unbounded server-side round trip, so an
    // all-fail phase must not churn every candidate (and emit a warn per
    // candidate) until the route's 300 s platform cap. Two stops, both
    // degrading to "whatever resolved so far" — never failing the step:
    // (a) an aggregate budget for the WHOLE phase (the shared 15 s ingest
    // constant, raced against each probe so even ONE hanging probe cannot
    // outlive it) and (b) a consecutive-failure fuse (3 unresolvable/errored
    // candidates in a row → stop). When a stop fires, every candidate that
    // did not resolve — unresolvable OR unprobed — is STRIPPED from the
    // mapping, so the generator can never hand an unresolved allocated id to
    // the defensive aiCall resolution (which would re-open the unbounded
    // probe the stop just closed); ONE summary warn names the stop.
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    const phaseBudget = new Promise<'__vision-resolution-budget-expired__'>((resolve) => {
      phaseTimer = setTimeout(
        () => resolve('__vision-resolution-budget-expired__'),
        VISION_RESOLUTION_BUDGET_MS,
      );
    });
    const resolvedById = new Map<string, VisionPromptImage>();
    let consecutiveUnresolvable = 0;
    let stopReason: 'fuse' | 'budget' | null = null;
    for (const candidate of withSrc) {
      if (resolvedById.size >= MAX_VISION_IMAGES) break;
      if (consecutiveUnresolvable >= MAX_CONSECUTIVE_UNRESOLVABLE_VISION_IMAGES) {
        stopReason = 'fuse';
        break;
      }
      let attempted: VisionPromptImage[] | '__vision-resolution-budget-expired__';
      try {
        attempted = await Promise.race([
          ctx.resolveVisionImages([
            {
              id: candidate.id,
              src: imageMapping[candidate.id],
              ...(candidate.width !== undefined ? { width: candidate.width } : {}),
              ...(candidate.height !== undefined ? { height: candidate.height } : {}),
            },
          ]),
          phaseBudget,
        ]);
      } catch (error) {
        // A throwing probe counts as an unresolvable candidate (an errored
        // store must degrade, never fail the step).
        log.error(
          `Vision image resolution probe for "${candidate.id}" failed; treating it as unresolvable:`,
          error,
        );
        attempted = [];
      }
      if (attempted === '__vision-resolution-budget-expired__') {
        stopReason = 'budget';
        break;
      }
      if (attempted.length === 1) {
        resolvedById.set(attempted[0]!.id, attempted[0]!);
        consecutiveUnresolvable = 0;
      } else {
        consecutiveUnresolvable += 1;
      }
    }
    if (phaseTimer !== undefined) clearTimeout(phaseTimer);
    resolvedVisionImages = [...resolvedById.values()];
    // Every candidate that did not resolve — an unresolvable probe, OR an
    // unprobed one when the fuse/budget stopped the phase — is stripped from
    // the mapping and the assigned set, so the generator's re-slice (same
    // helper, same cap) can never admit an image this step has not resolved
    // (possibly all of them = text-only generation).
    const droppedIds = new Set(
      withSrc
        .filter((candidate) => !resolvedById.has(candidate.id))
        .map((candidate) => candidate.id),
    );
    if (droppedIds.size > 0) {
      assignedImages = assignedImages.filter((img) => !droppedIds.has(img.id));
      visionImageMapping = Object.fromEntries(
        Object.entries(imageMapping).filter(([id]) => !droppedIds.has(id)),
      );
    }
    if (stopReason !== null) {
      log.warn(
        `Stopped probing vision image candidates early: the ${
          stopReason === 'fuse'
            ? `consecutive-failure fuse (${MAX_CONSECUTIVE_UNRESOLVABLE_VISION_IMAGES} unresolvable in a row)`
            : `${VISION_RESOLUTION_BUDGET_MS}ms aggregate resolution budget`
        } fired; proceeding to generation with ${resolvedById.size} resolved image(s) and the rest dropped to text-only (degrade, not fail).`,
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

  const content = await generateContent(effectiveOutline, aiCall, {
    assignedImages,
    imageMapping: visionImageMapping,
    visionEnabled: hasVision,
    generatedMediaMapping,
    resolvedVisionImages,
    agents,
    languageDirective,
    targetLanguage: input.targetLanguage || undefined,
    userRequirements: requirements,
    allowProceduralSkill: vocationalActive,
    ...(effectiveOutline.type === 'pbl'
      ? {
          pblLoopFallback: (plannerInput) =>
            generatePBLV2Project(
              plannerInput,
              languageModel,
              callLLM,
              { logger: log },
              thinkingConfig,
            ),
        }
      : {}),
  });

  if (!content) {
    log.error(`Failed to generate content for: "${effectiveOutline.title}"`);

    throw new StepRefusal<SceneContentRefusal>(
      'generation-failed',
      `Failed to generate content: ${effectiveOutline.title}`,
    );
  }

  log.info(`Content generated successfully: "${effectiveOutline.title}"`);
  return { content, effectiveOutline };
}
