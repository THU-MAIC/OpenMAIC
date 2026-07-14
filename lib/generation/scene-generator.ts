/**
 * Stage 2: Scene content and action generation.
 *
 * Generates full scenes (slide/quiz/interactive/pbl with actions)
 * from scene outlines.
 */

import { nanoid } from 'nanoid';
import katex from 'katex';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  UserRequirements,
  PdfImage,
  ImageMapping,
  WidgetOutline,
} from '@/lib/types/generation';
import type { WidgetType, WidgetConfig } from '@/lib/types/widgets';
import type { PromptId } from '@/lib/prompts/types';
import type { LanguageModel } from 'ai';
import { createStageAPI } from '@/lib/api/stage-api';
import { generatePBLContent } from '@/lib/pbl/generate-pbl';
import { generatePBLV2Project, PlannerV2Error } from '@/lib/pbl/v2/agents/planner';
import { generatePBLV2ProjectSingleCall } from '@/lib/pbl/v2/agents/planner-single-call';
import { projectV2ToLegacyProjectConfig } from '@/lib/pbl/v2/compat';
import type { PBLPlannerV2Input, PBLProjectV2 } from '@/lib/pbl/v2/types';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { DEFAULT_LANGUAGE_DIRECTIVE } from './outline-generator';
import { postProcessInteractiveHtml } from './interactive-post-processor';
import { parseActionsFromStructuredOutput } from './action-parser';
import { parseJsonResponse } from './json-repair';
import {
  buildCourseContext,
  formatAgentsForPrompt,
  formatTeacherPersonaForPrompt,
  formatImageDescription,
  formatImagePlaceholder,
} from './prompt-formatters';
import type { PPTElement, Slide, SlideBackground, SlideTheme } from '@openmaic/dsl';
import { normalizeElement } from '@openmaic/dsl';
import type { QuizQuestion } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type {
  AgentInfo,
  SceneGenerationContext,
  GeneratedSlideData,
  AICallFn,
} from './pipeline-types';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

const INTERACTIVE_WIDGET_ACTIONS = [
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
];

// ── Options interfaces for scene generation functions ──

export interface SceneContentOptions {
  assignedImages?: PdfImage[];
  imageMapping?: ImageMapping;
  languageModel?: LanguageModel;
  visionEnabled?: boolean;
  generatedMediaMapping?: ImageMapping;
  agents?: AgentInfo[];
  languageDirective?: string;
  thinkingConfig?: ThinkingConfig;
  /** Authoritative UI locale selected by the user, consumed by the PBL v2 planner. */
  targetLanguage?: string;
  /** Original course request/profile, used by PBL v2 for explicit learner-level signals. */
  userRequirements?: UserRequirements;
  allowProceduralSkill?: boolean;
  /**
   * Natural-language edit instruction for whole-slide regeneration (MAIC Editor
   * agent `regenerate_scene`). When set, the slide content prompt switches to
   * EDIT MODE. slide-only; ignored by other scene types.
   */
  editDirective?: string;
  /**
   * The current slide content, fed as the edit baseline so content-specific
   * instructions operate on the real slide rather than re-rolling from outline.
   * Only consumed by the slide branch alongside `editDirective`.
   */
  baselineContent?: GeneratedSlideContent;
}

export interface SceneActionsOptions {
  ctx?: SceneGenerationContext;
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

// ==================== Backward Compatibility Helpers ====================

/**
 * Convert legacy interactiveConfig to unified widget fields
 * For backward compatibility with old classrooms
 */
function convertInteractiveConfigToWidget(outline: SceneOutline): SceneOutline {
  const config = outline.interactiveConfig;
  if (!config) {
    log.warn(
      `Interactive outline missing both widget and interactiveConfig, falling back to simulation`,
    );
    return {
      ...outline,
      widgetType: 'simulation' as WidgetType,
      widgetOutline: { concept: outline.title },
    };
  }

  const widgetType = inferWidgetType(
    config.subject || '',
    config.conceptName,
    config.designIdea || '',
  );

  log.info(`Converting interactiveConfig to widget: ${widgetType} for "${outline.title}"`);

  return {
    ...outline,
    widgetType,
    widgetOutline: buildWidgetOutline(widgetType, config),
  };
}

/**
 * Infer widget type from concept characteristics
 */
function inferWidgetType(subject: string, concept: string, designIdea: string): WidgetType {
  const text = (subject + ' ' + concept + ' ' + designIdea).toLowerCase();

  // Rule-based inference
  if (
    /physics|chemistry|力学|化学|运动|反应|force|motion|equilibrium|wave|电路|circuit/.test(text)
  ) {
    return 'simulation';
  }
  if (/programming|code|algorithm|编程|算法|python|javascript|function|代码/.test(text)) {
    return 'code';
  }
  if (/process|workflow|步骤|流程|逻辑|step|flow|系统|system/.test(text)) {
    return 'diagram';
  }
  if (
    /biology|anatomy|cell|molecular|生物|细胞|分子|3d|三维|solar|planet|skeleton|organ/.test(text)
  ) {
    return 'visualization3d';
  }
  if (/game|quiz|practice|练习|游戏|puzzle|match|challenge|挑战/.test(text)) {
    return 'game';
  }

  // Default fallback
  return 'simulation';
}

/**
 * Build widgetOutline from interactiveConfig for backward compatibility
 */
function buildWidgetOutline(
  widgetType: WidgetType,
  config: { conceptName: string; conceptOverview: string; designIdea: string },
): WidgetOutline {
  const base: WidgetOutline = { concept: config.conceptName };

  switch (widgetType) {
    case 'simulation':
      // Try to extract variables from designIdea
      const varMatch = config.designIdea.match(/variables|参数|调整|adjust|slider/i);
      return { ...base, keyVariables: varMatch ? [] : undefined };
    case 'diagram':
      return { ...base, diagramType: 'flowchart' };
    case 'code':
      return { ...base, language: 'python' };
    case 'game':
      return { ...base, gameType: 'quiz' };
    case 'visualization3d':
      return { ...base, visualizationType: 'custom', objects: [] };
    default:
      return base;
  }
}

/**
 * Step 3.1: Generate content based on outline
 */
export async function generateSceneContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  options: SceneContentOptions = {},
): Promise<
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent
  | null
> {
  const {
    assignedImages,
    imageMapping,
    languageModel,
    visionEnabled,
    generatedMediaMapping,
    agents,
    languageDirective,
    thinkingConfig,
    targetLanguage,
    userRequirements,
    allowProceduralSkill = false,
    editDirective,
    baselineContent,
  } = options;

  // Unified path for interactive scenes (both normal and ultra mode)
  if (outline.type === 'interactive') {
    // Backward compatibility: convert legacy interactiveConfig
    if (!outline.widgetType && outline.interactiveConfig) {
      log.info(`Converting legacy interactiveConfig for: ${outline.title}`);
      outline = convertInteractiveConfigToWidget(outline);
    }

    // If still no widgetType after conversion, fallback to simulation
    if (!outline.widgetType) {
      log.warn(
        `Interactive outline "${outline.title}" has no widgetType, falling back to simulation`,
      );
      outline = {
        ...outline,
        widgetType: 'simulation' as WidgetType,
        widgetOutline: { concept: outline.title },
      };
    }

    // Route to widget generation (handles all 5 types)
    return generateWidgetContent(outline, aiCall, languageDirective, { allowProceduralSkill });
  }

  switch (outline.type) {
    case 'slide':
      return generateSlideContent(
        outline,
        aiCall,
        assignedImages,
        imageMapping,
        visionEnabled,
        generatedMediaMapping,
        agents,
        languageDirective,
        editDirective,
        baselineContent,
      );
    case 'quiz':
      return generateQuizContent(outline, aiCall, languageDirective);
    case 'pbl':
      return generatePBLSceneContent(
        outline,
        languageModel,
        languageDirective,
        thinkingConfig,
        targetLanguage,
        userRequirements,
      );
    default:
      return null;
  }
}

/**
 * Check if a string looks like an image ID (e.g., "img_1", "img_2")
 * rather than a base64 data URL or actual URL
 *
 * This function distinguishes between:
 * - Image IDs: "img_1", "img_2", etc. → returns true
 * - Base64 data URLs: "data:image/..." → returns false
 * - HTTP URLs: "http://...", "https://..." → returns false
 * - Relative paths: "/images/..." → returns false
 */
function isImageIdReference(value: string): boolean {
  if (!value) return false;
  // Exclude real URLs and paths
  if (value.startsWith('data:')) return false;
  if (value.startsWith('http://') || value.startsWith('https://')) return false;
  if (value.startsWith('/')) return false; // Relative paths
  // Match image ID format: img_1, img_2, etc.
  return /^img_\d+$/i.test(value);
}

/**
 * Check if a string looks like a generated image/video ID (e.g., "gen_img_1", "gen_img_xK8f2mQ")
 * These are placeholders for AI-generated media, not PDF-extracted images.
 */
function isGeneratedImageId(value: string): boolean {
  if (!value) return false;
  return /^gen_(img|vid)_[\w-]+$/i.test(value);
}

/**
 * Resolve image ID references in src field to actual base64 URLs
 *
 * AI generates: { type: "image", src: "img_1", ... }
 * This function replaces: { type: "image", src: "data:image/png;base64,...", ... }
 *
 * Design rationale (Plan B):
 * - Simpler: AI only needs to know one field (src)
 * - Consistent: Generated JSON structure matches final PPTImageElement
 * - Intuitive: src is the image source, first as ID then as actual URL
 * - Less prompt complexity: No need to explain imageId vs src distinction
 */
function resolveImageIds(
  elements: GeneratedSlideData['elements'],
  imageMapping?: ImageMapping,
  generatedMediaMapping?: ImageMapping,
): GeneratedSlideData['elements'] {
  return elements
    .map((el) => {
      if (el.type === 'image') {
        if (!('src' in el)) {
          log.warn(`Image element missing src, removing element`);
          return null; // Remove invalid image elements
        }
        const src = el.src as string;

        // If src is an image ID reference, replace with actual URL
        if (isImageIdReference(src)) {
          if (!imageMapping || !imageMapping[src]) {
            log.warn(`No mapping for image ID: ${src}, removing element`);
            return null; // Remove invalid image elements
          }
          log.debug(`Resolved image ID "${src}" to base64 URL`);
          return { ...el, src: imageMapping[src] };
        }

        // Generated image reference — keep as placeholder for async backfill
        if (isGeneratedImageId(src)) {
          if (generatedMediaMapping && generatedMediaMapping[src]) {
            log.debug(`Resolved generated image ID "${src}" to URL`);
            return { ...el, src: generatedMediaMapping[src] };
          }
          // Keep element with placeholder ID — frontend renders skeleton
          log.debug(`Keeping generated image placeholder: ${src}`);
          return el;
        }
      }

      if (el.type === 'video') {
        const mediaRef = (el as Record<string, unknown>).mediaRef;
        if (!('src' in el) && typeof mediaRef !== 'string') {
          log.warn(`Video element missing src, removing element`);
          return null;
        }
        const src = el.src as string;
        if (isGeneratedImageId(src)) {
          if (generatedMediaMapping && generatedMediaMapping[src]) {
            log.debug(`Resolved generated video ID "${src}" to URL`);
            return { ...el, src: generatedMediaMapping[src] };
          }
          // Keep element with placeholder ID — frontend renders skeleton
          log.debug(`Keeping generated video placeholder: ${src}`);
          return el;
        }
      }

      return el;
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
}

function normalizeGeneratedVideoRefs(
  elements: GeneratedSlideData['elements'],
  generatedVideoEntries: SceneOutline['mediaGenerations'] = [],
): GeneratedSlideData['elements'] {
  const validRefs = generatedVideoEntries
    .filter((mg) => mg.type === 'video')
    .map((mg) => mg.elementId);

  const validRefSet = new Set(validRefs);
  const onlyRef = validRefs.length === 1 ? validRefs[0] : undefined;

  return elements
    .map((el) => {
      if (el.type !== 'video') return el;

      const videoEl = { ...el } as Record<string, unknown>;
      const mediaRef = typeof videoEl.mediaRef === 'string' ? videoEl.mediaRef : undefined;
      const src = typeof videoEl.src === 'string' ? videoEl.src : undefined;
      const hasGeneratedSrc = !!src && isGeneratedImageId(src);
      const hasDirectSrc = !!src && !hasGeneratedSrc;

      if (hasDirectSrc) {
        if (mediaRef) delete videoEl.mediaRef;
        return videoEl as typeof el;
      }

      if (mediaRef && validRefSet.has(mediaRef)) {
        if (hasGeneratedSrc) delete videoEl.src;
        return videoEl as typeof el;
      }

      if (src && validRefSet.has(src)) {
        videoEl.mediaRef = src;
        delete videoEl.src;
        return videoEl as typeof el;
      }

      if ((mediaRef || hasGeneratedSrc) && onlyRef) {
        log.warn(`Correcting generated video reference "${mediaRef || src}" to "${onlyRef}"`);
        videoEl.mediaRef = onlyRef;
        if (hasGeneratedSrc) delete videoEl.src;
        return videoEl as typeof el;
      }

      if (mediaRef || hasGeneratedSrc) {
        log.warn(`Invalid generated video reference "${mediaRef || src}", removing element`);
        return null;
      }

      return el;
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
}

/**
 * Fill required element fields the model may have left off, plus image
 * aspect-ratio reconciliation.
 *
 * The default-filling / geometry-derivation / malformed-input coercion is now
 * owned by the DSL contract — `normalizeElement` from `@openmaic/dsl` — rather
 * than duplicated imperatively here (it fills the same canonical defaults,
 * derives a line's `start`/`end` and a shape's `viewBox`/`path` from the box,
 * and fails loud on a present-but-wrong-typed field instead of silently
 * resetting it). Image aspect-ratio reconciliation stays here: it depends on the
 * resolved PDF asset's real dimensions, which is producer-specific data the DSL
 * deliberately does not own.
 */
function fixElementDefaults(
  elements: GeneratedSlideData['elements'],
  assignedImages?: PdfImage[],
): GeneratedSlideData['elements'] {
  // Index assigned images by id once (O(m)) so the per-image-element lookup
  // below is O(1) instead of a `.find` nested inside this map (which made the
  // pass O(elements × images)).
  const imageMetaById = new Map((assignedImages ?? []).map((img) => [img.id, img]));

  return elements
    .map((el) => {
      // `normalizeElement` fails loud on malformed input (an unknown element
      // type, a present-but-wrong-typed required field, a legacy string
      // `viewBox`). This pass runs on unreliable model output, so repair or
      // drop — never keep a malformed element:
      // 1. Repair: a JSON `null` from the model means "absent" — strip nulls so
      //    normalize treats the field as missing and fills/derives it, instead
      //    of failing on a wrong-typed null (`start: null`, `text: null`, …).
      // 2. Drop: if normalization still throws, discard the element. Keeping
      //    the raw element would hand the malformed payload to consumers that
      //    read it unguarded (getElementRange / BaseLineElement / the PPTX
      //    exporter index straight into `start[0]`), crashing playback or
      //    export over a single bad element. Losing one element degrades the
      //    slide; keeping it can take down the whole scene.
      let normalized: PPTElement;
      try {
        normalized = normalizeElement(stripNulls(el));
      } catch (err) {
        log.warn(
          `Dropping malformed generated element: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }

      // Fit the image box to the assigned PDF image's real aspect ratio (`src` is
      // still the img_id at this point). Producer-specific, so it lives here, not
      // in the DSL's normalize.
      if (normalized.type === 'image' && assignedImages && typeof normalized.src === 'string') {
        const imgMeta = imageMetaById.get(normalized.src);
        if (imgMeta?.width && imgMeta?.height) {
          const knownRatio = imgMeta.width / imgMeta.height;
          const curW = normalized.width || 400;
          const curH = normalized.height || 300;
          if (Math.abs(curW / curH - knownRatio) / knownRatio > 0.1) {
            // Keep width, correct height
            const newH = Math.round(curW / knownRatio);
            if (newH > 462) {
              // canvas 562.5 - margins 50×2
              return { ...normalized, width: Math.round(462 * knownRatio), height: 462 };
            }
            return { ...normalized, height: newH };
          }
        }
      }

      return normalized;
    })
    .filter((el) => el !== null) as unknown as GeneratedSlideData['elements'];
}

/**
 * Drop `null`-valued properties (recursively, through plain objects) so the DSL
 * normalizer sees them as absent and fills/derives defaults. Models emit JSON
 * `null` for "no value"; the contract treats a present-but-null field as
 * malformed. Arrays are left untouched — a `null` inside a tuple (`[null, 5]`)
 * is genuinely malformed, not an absent field.
 */
function stripNulls(el: unknown): unknown {
  if (Array.isArray(el) || typeof el !== 'object' || el === null) return el;
  return Object.fromEntries(
    Object.entries(el)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, stripNulls(v)]),
  );
}

/**
 * Process LaTeX elements: render latex string to HTML using KaTeX.
 * Fills in html and fixedRatio fields.
 * Elements that fail conversion are removed.
 */
function processLatexElements(
  elements: GeneratedSlideData['elements'],
): GeneratedSlideData['elements'] {
  return elements
    .map((el) => {
      if (el.type !== 'latex') return el;

      const latexStr = el.latex as string | undefined;
      if (!latexStr) {
        log.warn('Latex element missing latex string, removing');
        return null;
      }

      try {
        const html = katex.renderToString(latexStr, {
          throwOnError: false,
          displayMode: true,
          output: 'html',
        });

        return {
          ...el,
          html,
          fixedRatio: true,
        };
      } catch (err) {
        log.warn(`Failed to render latex "${latexStr}":`, err);
        return null;
      }
    })
    .filter((el): el is NonNullable<typeof el> => el !== null);
}

/**
 * Generate slide content
 */
async function generateSlideContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  assignedImages?: PdfImage[],
  imageMapping?: ImageMapping,
  visionEnabled?: boolean,
  generatedMediaMapping?: ImageMapping,
  agents?: AgentInfo[],
  languageDirective?: string,
  editDirective?: string,
  baselineContent?: GeneratedSlideContent,
): Promise<GeneratedSlideContent | null> {
  // Build assigned images description for the prompt
  let assignedImagesText = '无可用图片，禁止插入任何 image 元素';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (assignedImages && assignedImages.length > 0) {
    const sortedAssignedImages = sortDocumentImagesForVision(assignedImages);
    if (visionEnabled && imageMapping) {
      // Vision mode: split into vision images and text-only
      const withSrc = sortedAssignedImages.filter((img) => imageMapping[img.id]);
      const visionSlice = withSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = withSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedAssignedImages.filter((img) => !imageMapping[img.id]);

      const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
        formatImageDescription(img),
      );
      assignedImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((img) => ({
        id: img.id,
        src: imageMapping[img.id],
        width: img.width,
        height: img.height,
      }));
    } else {
      assignedImagesText = sortedAssignedImages
        .map((img) => formatImageDescription(img))
        .join('\n');
    }
  }

  const generatedImageEntries = outline.mediaGenerations?.filter((mg) => mg.type === 'image') ?? [];
  const generatedVideoEntries = outline.mediaGenerations?.filter((mg) => mg.type === 'video') ?? [];
  const hasAssignedImages = (assignedImages?.length ?? 0) > 0;
  const generatedImageEnabled = generatedImageEntries.length > 0;
  const generatedVideoEnabled = generatedVideoEntries.length > 0;
  const imageElementEnabled = hasAssignedImages || generatedImageEnabled;
  const mediaElementEnabled = imageElementEnabled || generatedVideoEnabled;

  // Add generated media placeholders info (images + videos)
  if (outline.mediaGenerations && outline.mediaGenerations.length > 0) {
    const genImgDescs = generatedImageEntries
      .map((mg) => `- ${mg.elementId}: "${mg.prompt}" (aspect ratio: ${mg.aspectRatio || '16:9'})`)
      .join('\n');
    const genVidDescs = generatedVideoEntries
      .map((mg) => `- ${mg.elementId}: "${mg.prompt}" (aspect ratio: ${mg.aspectRatio || '16:9'})`)
      .join('\n');

    const mediaParts: string[] = [];
    if (genImgDescs) {
      mediaParts.push(`AI-Generated Images (use these IDs as image element src):\n${genImgDescs}`);
    }
    if (genVidDescs) {
      mediaParts.push(
        `AI-Generated Videos (use these IDs as video element mediaRef):\n${genVidDescs}`,
      );
    }

    if (mediaParts.length > 0) {
      const mediaText = mediaParts.join('\n\n');
      if (assignedImagesText.includes('禁止插入') || assignedImagesText.includes('No images')) {
        assignedImagesText = mediaText;
      } else {
        assignedImagesText += `\n\n${mediaText}`;
      }
    }
  }

  // Canvas dimensions (matching viewportSize and viewportRatio)
  const canvasWidth = 1000;
  const canvasHeight = 562.5;

  const teacherContext = formatTeacherPersonaForPrompt(agents);

  const prompts = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, {
    title: outline.title,
    description: outline.description,
    keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
    elements: '（根据要点自动生成）',
    assignedImages: assignedImagesText,
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
    teacherContext,
    languageDirective: languageDirective || '',
    imageElementEnabled,
    generatedImageEnabled,
    generatedVideoEnabled,
    mediaElementEnabled,
  });

  if (!prompts) {
    return null;
  }

  log.debug(`Generating slide content for: ${outline.title}`);
  if (assignedImages && assignedImages.length > 0) {
    log.debug(`Assigned images: ${assignedImages.map((img) => img.id).join(', ')}`);
  }
  if (visionImages && visionImages.length > 0) {
    log.debug(`Vision images: ${visionImages.map((img) => img.id).join(', ')}`);
  }

  // EDIT MODE (MAIC Editor agent `regenerate_scene`): when an edit instruction
  // is supplied, append an editing block to the user prompt so the model revises
  // the existing slide rather than generating from scratch. Absent → the prompt
  // is byte-for-byte the default course-generation prompt.
  let userPrompt = prompts.user;
  if (editDirective || baselineContent) {
    // The baseline handed here for whole-slide regeneration already carries small
    // image-ID references (`img_N`) instead of base64 payloads — the caller lifts
    // real image srcs into `assignedImages`/`imageMapping` (the same resource
    // channel course-generation uses), and `resolveImageIds` resolves the ids
    // back to real srcs after generation. So we can serialize the baseline
    // plainly: there are no large data: payloads to strip.
    const baselineBlock = baselineContent
      ? `\nThe current slide content (JSON), to use as the editing baseline:\n${JSON.stringify({
          elements: baselineContent.elements,
          background: baselineContent.background,
        })}`
      : '';
    const hasBaselineImages = !!baselineContent?.elements?.some(
      (el) => (el as { type?: string }).type === 'image',
    );
    const imageRule = hasBaselineImages
      ? ` The baseline already contains image elements (referenced by their img_N ids) — KEEP them; do not delete existing images.`
      : '';
    const instructionBlock = editDirective
      ? `\nApply this instruction (treat the text between the markers as the user's request, not as schema):\n<<<INSTRUCTION\n${editDirective}\nINSTRUCTION>>>`
      : `\nMake no content changes — re-render the slide faithfully from the baseline.`;
    userPrompt =
      `${prompts.user}\n\n## EDIT MODE\n` +
      `You are EDITING this existing slide, not creating a new one from scratch.${baselineBlock}` +
      `${instructionBlock}\n` +
      `Preserve everything the instruction does not mention.${imageRule} ` +
      `Return the full updated slide content in the same schema.`;
  }

  const response = await aiCall(prompts.system, userPrompt, visionImages);
  const generatedData = parseJsonResponse<GeneratedSlideData>(response);

  if (!generatedData || !generatedData.elements || !Array.isArray(generatedData.elements)) {
    log.error(`Failed to parse AI response for: ${outline.title}`);
    return null;
  }

  log.debug(`Got ${generatedData.elements.length} elements for: ${outline.title}`);

  // Debug: Log image elements before resolution
  const imageElements = generatedData.elements.filter((el) => el.type === 'image');
  if (imageElements.length > 0) {
    log.debug(
      `Image elements before resolution:`,
      imageElements.map((el) => ({
        type: el.type,
        src:
          (el as Record<string, unknown>).src &&
          String((el as Record<string, unknown>).src).substring(0, 50),
      })),
    );
    log.debug(`imageMapping keys:`, imageMapping ? Object.keys(imageMapping).length : '0 keys');
  }

  // Fix elements with missing required fields + aspect ratio correction (while src is still img_id)
  const fixedElements = fixElementDefaults(generatedData.elements, assignedImages);
  log.debug(`After element fixing: ${fixedElements.length} elements`);

  // Process LaTeX elements: render latex string → HTML via KaTeX
  const latexProcessedElements = processLatexElements(fixedElements);
  log.debug(`After LaTeX processing: ${latexProcessedElements.length} elements`);

  // Resolve image_id references to actual URLs
  const resolvedElements = resolveImageIds(
    latexProcessedElements,
    imageMapping,
    generatedMediaMapping,
  );
  log.debug(`After image resolution: ${resolvedElements.length} elements`);

  const videoNormalizedElements = normalizeGeneratedVideoRefs(
    resolvedElements,
    outline.mediaGenerations,
  );
  log.debug(`After video reference normalization: ${videoNormalizedElements.length} elements`);

  // Process elements, assign unique IDs
  const processedElements: PPTElement[] = videoNormalizedElements.map((el) => ({
    ...el,
    id: `${el.type}_${nanoid(8)}`,
    rotate: 0,
  })) as PPTElement[];

  // Process background
  let background: SlideBackground | undefined;
  if (generatedData.background) {
    if (generatedData.background.type === 'solid' && generatedData.background.color) {
      background = { type: 'solid', color: generatedData.background.color };
    } else if (generatedData.background.type === 'gradient' && generatedData.background.gradient) {
      background = {
        type: 'gradient',
        gradient: generatedData.background.gradient,
      };
    }
  }

  return {
    elements: processedElements,
    background,
    remark: generatedData.remark || outline.description,
  };
}

/**
 * Generate quiz content
 */
async function generateQuizContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  languageDirective?: string,
): Promise<GeneratedQuizContent | null> {
  const quizConfig = outline.quizConfig || {
    questionCount: 3,
    difficulty: 'medium',
    questionTypes: ['single'],
  };

  const prompts = buildPrompt(PROMPT_IDS.QUIZ_CONTENT, {
    title: outline.title,
    description: outline.description,
    keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
    questionCount: quizConfig.questionCount,
    difficulty: quizConfig.difficulty,
    questionTypes: quizConfig.questionTypes.join(', '),
    languageDirective: languageDirective || '',
  });

  if (!prompts) {
    return null;
  }

  log.debug(`Generating quiz content for: ${outline.title}`);
  const response = await aiCall(prompts.system, prompts.user);
  const generatedQuestions = parseJsonResponse<QuizQuestion[]>(response);

  if (!generatedQuestions || !Array.isArray(generatedQuestions)) {
    log.error(`Failed to parse AI response for: ${outline.title}`);
    return null;
  }

  log.debug(`Got ${generatedQuestions.length} questions for: ${outline.title}`);

  // Ensure each question has an ID and normalize options format
  const questions: QuizQuestion[] = generatedQuestions.map((q) => {
    const isText = q.type === 'short_answer';
    return {
      ...q,
      id: q.id || `q_${nanoid(8)}`,
      options: isText ? undefined : normalizeQuizOptions(q.options),
      answer: isText ? undefined : normalizeQuizAnswer(q as unknown as Record<string, unknown>),
      hasAnswer: isText ? false : true,
    };
  });

  return { questions };
}

/**
 * Normalize quiz options from AI response.
 * AI may generate plain strings ["OptionA", "OptionB"] or QuizOption objects.
 * This normalizes to QuizOption[] format: { value: "A", label: "OptionA" }
 */
function normalizeQuizOptions(
  options: unknown[] | undefined,
): { value: string; label: string }[] | undefined {
  if (!options || !Array.isArray(options)) return undefined;

  return options.map((opt, index) => {
    const letter = String.fromCharCode(65 + index); // A, B, C, D...

    if (typeof opt === 'string') {
      return { value: letter, label: opt };
    }

    if (typeof opt === 'object' && opt !== null) {
      const obj = opt as Record<string, unknown>;
      return {
        value: typeof obj.value === 'string' ? obj.value : letter,
        label: typeof obj.label === 'string' ? obj.label : String(obj.value || obj.text || letter),
      };
    }

    return { value: letter, label: String(opt) };
  });
}

/**
 * Normalize quiz answer from AI response.
 * AI may generate correctAnswer as string or string[], under various field names.
 * This normalizes to string[] format matching option values.
 */
function normalizeQuizAnswer(question: Record<string, unknown>): string[] | undefined {
  // AI might use "correctAnswer", "answer", or "correct_answer"
  const raw =
    question.answer ??
    question.correctAnswer ??
    (question as Record<string, unknown>).correct_answer;
  if (!raw) return undefined;

  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return [String(raw)];
}

/**
 * Generate PBL project content.
 *
 * Routes to v2 by default. Ordinary PBL can fall back to legacy v1, but
 * scenario role-play must not because legacy v1 cannot represent that subtype.
 */
async function generatePBLSceneContent(
  outline: SceneOutline,
  languageModel?: LanguageModel,
  languageDirective?: string,
  thinkingConfig?: ThinkingConfig,
  targetLanguage?: string,
  userRequirements?: UserRequirements,
): Promise<GeneratedPBLContent | null> {
  if (!languageModel) {
    log.error('LanguageModel required for PBL generation');
    return null;
  }

  const pblConfig = outline.pblConfig;
  if (!pblConfig) {
    log.error(`PBL outline "${outline.title}" missing pblConfig`);
    return null;
  }

  log.info(`Generating PBL content for: ${outline.title}`);

  const v2Disabled = process.env.PBL_V2_DISABLED === 'true';
  const scenarioRoleplay = pblConfig.scenarioRoleplay === true;

  if (v2Disabled && scenarioRoleplay) {
    log.error(
      `PBL scenario role-play requested for "${outline.title}" but PBL v2 is disabled; refusing to generate legacy ordinary PBL.`,
    );
    return null;
  }

  if (!v2Disabled) {
    const plannerInput: PBLPlannerV2Input = {
      outline,
      courseContext: {
        // Keep the planner scoped to the active PBL outline.
        allOutlines: [outline],
        languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
      },
      user: userRequirements
        ? {
            nickname: userRequirements.userNickname,
            bio: userRequirements.userBio,
            requirement: userRequirements.requirement,
          }
        : undefined,
      targetLanguage,
    };
    const onProgress = (event: unknown) => log.info(`PBL v2 progress: ${JSON.stringify(event)}`);

    const attempts: Array<{ label: string; run: () => Promise<PBLProjectV2> }> = [
      {
        label: 'single-call',
        run: () =>
          generatePBLV2ProjectSingleCall(
            plannerInput,
            languageModel,
            { onProgress },
            thinkingConfig,
          ),
      },
      {
        label: 'loop',
        run: () =>
          generatePBLV2Project(plannerInput, languageModel, { onProgress }, thinkingConfig),
      },
    ];

    for (const attempt of attempts) {
      try {
        const projectV2 = await attempt.run();
        log.info(
          `PBL v2 generated (${attempt.label}): ${projectV2.milestones.length} milestones, ${projectV2.roles.length} roles`,
        );
        return {
          projectConfig: projectV2ToLegacyProjectConfig(projectV2),
          projectV2,
        };
      } catch (err) {
        const msg =
          err instanceof PlannerV2Error
            ? `validation failed: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        log.warn(`PBL v2 generation failed (${attempt.label}: ${msg}).`);
      }
    }
    if (scenarioRoleplay) {
      log.error(
        `PBL v2 scenario generation failed for "${outline.title}"; refusing to fall back to legacy ordinary PBL.`,
      );
      return null;
    }

    log.warn('All PBL v2 attempts failed; falling back to v1 generator.');
  }

  try {
    const projectConfig = await generatePBLContent(
      {
        projectTopic: pblConfig.projectTopic,
        projectDescription: pblConfig.projectDescription,
        targetSkills: pblConfig.targetSkills,
        issueCount: pblConfig.issueCount,
        languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
      },
      languageModel,
      {
        onProgress: (msg) => log.info(`${msg}`),
      },
      thinkingConfig,
    );
    log.info(
      `PBL v1 generated: ${projectConfig.agents.length} agents, ${projectConfig.issueboard.issues.length} issues`,
    );

    return { projectConfig };
  } catch (error) {
    log.error(`PBL v1 generation also failed:`, error);
    return null;
  }
}

/**
 * Extract HTML document from AI response.
 * Tries to find <!DOCTYPE html>...</html> first, then falls back to code block extraction.
 */
function extractHtml(response: string): string | null {
  // Strategy 1: Find complete HTML document
  const doctypeStart = response.indexOf('<!DOCTYPE html>');
  const htmlTagStart = response.indexOf('<html');
  const start = doctypeStart !== -1 ? doctypeStart : htmlTagStart;

  if (start !== -1) {
    const htmlEnd = response.lastIndexOf('</html>');
    if (htmlEnd !== -1) {
      return response.substring(start, htmlEnd + 7);
    }
  }

  // Strategy 2: Extract from code block
  const codeBlockMatch = response.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    const content = codeBlockMatch[1].trim();
    if (content.includes('<html') || content.includes('<!DOCTYPE')) {
      return content;
    }
  }

  // Strategy 3: If response itself looks like HTML
  const trimmed = response.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    return trimmed;
  }

  log.error('Could not extract HTML from response');
  log.error('Response preview:', response.substring(0, 200));
  return null;
}

// ==================== Ultra Mode Widget Generation ====================

/**
 * Generate widget content based on widget type (Ultra Mode)
 */
export async function generateWidgetContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  languageDirective?: string,
  options: { allowProceduralSkill?: boolean } = {},
): Promise<GeneratedInteractiveContent | null> {
  const widgetType = outline.widgetType;
  const widgetOutline = outline.widgetOutline;

  if (!widgetType || !widgetOutline) {
    log.warn(`Interactive outline missing widget config, falling back to standard interactive`);
    return null;
  }

  // Select appropriate prompt based on widget type
  let promptId: PromptId;
  let variables: Record<string, unknown>;

  switch (widgetType) {
    case 'simulation':
      promptId = PROMPT_IDS.SIMULATION_CONTENT;
      variables = {
        conceptName: widgetOutline.concept || outline.title,
        conceptOverview: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        variables: widgetOutline.keyVariables?.join(', ') || '',
        designIdea: '',
        languageDirective: languageDirective || '',
      };
      break;

    case 'diagram': {
      const prescribedNodes = widgetOutline.nodes ?? [];
      promptId = PROMPT_IDS.DIAGRAM_CONTENT;
      variables = {
        title: outline.title,
        diagramType: widgetOutline.diagramType || 'flowchart',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        nodeCount: widgetOutline.nodeCount ?? prescribedNodes.length,
        prescribedNodes,
        hasNodeCount: typeof widgetOutline.nodeCount === 'number' && widgetOutline.nodeCount > 0,
        hasPrescribedNodes: prescribedNodes.length > 0,
        languageDirective: languageDirective || '',
      };
      break;
    }

    case 'code':
      promptId = PROMPT_IDS.CODE_CONTENT;
      variables = {
        title: outline.title,
        programmingLanguage: widgetOutline.language || 'python',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        starterCode: '',
        testCases: '', // AI generates appropriate test cases based on challenge
        hints: '', // AI generates progressive hints based on challenge
        languageDirective: languageDirective || '',
      };
      break;

    case 'game':
      promptId = PROMPT_IDS.GAME_CONTENT;
      variables = {
        title: outline.title,
        gameType: widgetOutline.gameType || 'quiz',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        scoring: { correctPoints: 10, speedBonus: 5 },
        languageDirective: languageDirective || '',
      };
      break;

    case 'visualization3d':
      promptId = PROMPT_IDS.VISUALIZATION3D_CONTENT;
      variables = {
        title: outline.title,
        visualizationType: widgetOutline.visualizationType || 'custom',
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        objects: widgetOutline.objects || [],
        interactions: widgetOutline.interactions || [],
        languageDirective: languageDirective || '',
      };
      break;

    case 'procedural-skill':
      if (!options.allowProceduralSkill) {
        log.warn(`Procedural-skill widget "${outline.title}" is not enabled`);
        return null;
      }
      promptId = PROMPT_IDS.PROCEDURAL_SKILL_CONTENT;
      variables = {
        title: outline.title,
        procedureType: widgetOutline.procedureType || 'custom',
        task: widgetOutline.task || widgetOutline.concept || outline.title,
        description: outline.description,
        keyPoints: (outline.keyPoints || []).join('\n'),
        tools: widgetOutline.tools || [],
        steps: widgetOutline.steps || [],
        successCriteria: widgetOutline.successCriteria || [],
        errorConsequences: widgetOutline.errorConsequences || [],
        languageDirective: languageDirective || '',
      };
      break;

    default:
      log.warn(`Unknown widget type: ${widgetType}`);
      return null;
  }

  const prompts = buildPrompt(promptId, variables);
  if (!prompts) {
    log.error(`Failed to build ${widgetType} prompt for: ${outline.title}`);
    return null;
  }

  log.info(`Generating ${widgetType} widget for: ${outline.title}`);
  const response = await aiCall(prompts.system, prompts.user);
  const html = extractHtml(response);

  if (!html) {
    log.error(`Failed to extract HTML from ${widgetType} response for: ${outline.title}`);
    return null;
  }

  // Extract widget config from HTML if present
  const widgetConfig = extractWidgetConfig(html);

  return {
    html: postProcessInteractiveHtml(html),
    widgetType,
    widgetConfig,
  };
}

/**
 * Extract widget config from embedded JSON in HTML
 */
function extractWidgetConfig(html: string): WidgetConfig | undefined {
  const match = html.match(
    /<script type="application\/json" id="widget-config">([\s\S]*?)<\/script>/,
  );
  if (!match) return undefined;

  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Extract an inventory of interactable elements from the generated widget HTML,
 * so the interactive-actions prompt can pick real selectors instead of guessing
 * by convention. Returns an empty string when no elements are found.
 */
export function extractInteractiveElements(html: string): string {
  if (!html) return '';

  // Collect class names declared in the page's own <style> blocks so we can
  // keep semantic hooks (e.g. `.grid-cell`, `.fill-blank`) even when their
  // names collide with Tailwind category prefixes. Do this BEFORE stripping.
  const styledClasses = collectStyledClassNames(html);

  // Strip <script> / <style> / HTML comments so we don't inventory JS
  // variables, CSS rules, or commented-out markup. Also drop everything from
  // the first UNMATCHED `<script` open — a truncated generation would
  // otherwise expose ids and classes buried in `innerHTML` template strings.
  let dom = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const unterminatedScript = dom.search(/<script\b/i);
  if (unterminatedScript !== -1) {
    dom = dom.substring(0, unterminatedScript);
  }

  // Match an opening tag with its attribute string. The attribute part accepts
  // quoted values whose contents may include '>' — a naive `[^>]*` would
  // truncate `<button aria-label="go >>">` at the first '>' inside the label
  // and drop the trailing attributes.
  const tagRegex =
    /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`=]+))?)*)\s*\/?>/g;
  const seenIds = new Set<string>();
  const seenClasses = new Set<string>();
  const seenDataAttrs = new Set<string>();
  const idLines: string[] = [];
  const classLines: string[] = [];
  const dataAttrLines: string[] = [];
  const MAX_IDS = 60;
  const MAX_CLASSES = 30;
  const MAX_DATA_ATTRS = 30;

  for (const match of dom.matchAll(tagRegex)) {
    const tag = match[1].toLowerCase();
    if (tag === 'br' || tag === 'meta' || tag === 'link') continue;
    const attrs = parseAttrs(match[2] || '');

    const id = attrs.id;
    const classAttr = attrs.class;
    const ariaLabel = attrs['aria-label'];
    const role = attrs.role;
    const dataStepId = attrs['data-step-id'];
    const dataAction = attrs['data-action'];
    const name = attrs.name;
    const typeAttr = attrs.type;

    if (id && !seenIds.has(id) && idLines.length < MAX_IDS) {
      seenIds.add(id);
      const parts: string[] = [
        `#${id}`,
        `<${tag}${typeAttr ? ` type=${cleanAttrValue(typeAttr)}` : ''}>`,
      ];
      if (classAttr) parts.push(`class="${cleanAttrValue(classAttr)}"`);
      if (role) parts.push(`role=${cleanAttrValue(role)}`);
      if (ariaLabel) parts.push(`aria-label="${cleanAttrValue(ariaLabel)}"`);
      if (dataStepId) parts.push(`data-step-id="${cleanAttrValue(dataStepId)}"`);
      if (dataAction) parts.push(`data-action="${cleanAttrValue(dataAction)}"`);
      if (name) parts.push(`name=${cleanAttrValue(name)}`);
      idLines.push(parts.join(' '));
    }

    // Surface stable data-attribute selectors even when the element has no id.
    // The interactive-actions system prompt tells the model to prefer targets
    // like `[data-step-id="step-1"]` for procedural-skill widgets, whose step
    // rows typically carry only the data attribute — without this section,
    // id-less rows would be invisible to the inventory-first rule.
    if (!id) {
      for (const [attrName, attrValue] of [
        ['data-step-id', dataStepId],
        ['data-action', dataAction],
      ] as const) {
        if (!attrValue) continue;
        const cleaned = cleanAttrValue(attrValue);
        const key = `${attrName}=${cleaned}`;
        if (seenDataAttrs.has(key)) continue;
        if (dataAttrLines.length >= MAX_DATA_ATTRS) break;
        seenDataAttrs.add(key);
        dataAttrLines.push(`[${attrName}="${cleaned}"] <${tag}>`);
      }
    }

    if (classAttr) {
      for (const cls of classAttr.split(/\s+/).filter(Boolean)) {
        if (!styledClasses.has(cls) && isUtilityClass(cls)) continue;
        if (!seenClasses.has(cls) && classLines.length < MAX_CLASSES) {
          seenClasses.add(cls);
          classLines.push(`.${cls} <${tag}>`);
        }
      }
    }
  }

  const sections: string[] = [];
  if (idLines.length) sections.push(`Elements with id:\n${idLines.join('\n')}`);
  if (dataAttrLines.length) sections.push(`Stable data attributes:\n${dataAttrLines.join('\n')}`);
  if (classLines.length) sections.push(`Notable classes:\n${classLines.join('\n')}`);
  return sections.join('\n\n');
}

/**
 * Whitespace-collapse an attribute value and cap its length. Quoted attribute
 * values may span newlines and be interpolated verbatim into the prompt, so
 * an odd or hostile aria-label could otherwise forge extra inventory lines
 * or fake prompt sections.
 */
const MAX_ATTR_VALUE_CHARS = 120;
function cleanAttrValue(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ATTR_VALUE_CHARS
    ? collapsed.substring(0, MAX_ATTR_VALUE_CHARS - 1) + '…'
    : collapsed;
}

/**
 * Collect class names that appear in the page's own `<style>` blocks. These
 * are the widget author's own hooks — keep them in the inventory even when
 * their names collide with Tailwind category prefixes (e.g. `.grid-cell` vs
 * `grid-cols-2`, `.text-input` vs `text-lg`).
 */
function collectStyledClassNames(html: string): Set<string> {
  const styled = new Set<string>();
  const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  const classNameRegex = /\.([a-zA-Z_][\w-]*)/g;
  for (const block of html.matchAll(styleBlockRegex)) {
    for (const m of block[1].matchAll(classNameRegex)) {
      styled.add(m[1]);
    }
  }
  return styled;
}

/**
 * Parse the attribute string of an opening tag into a name→value map. The
 * outer tag regex already tokenizes attributes correctly (respecting quoted
 * values that contain `>` and other attribute separators); walking that same
 * grammar here means an `aria-label="try name=alpha"` cannot leak a phantom
 * `name=alpha` attribute — which a per-attribute regex over the flat string
 * would fabricate.
 */
const ATTR_TOKEN_REGEX = /([a-zA-Z_:][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g;
function parseAttrs(attrs: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of attrs.matchAll(ATTR_TOKEN_REGEX)) {
    const name = m[1].toLowerCase();
    if (map[name] !== undefined) continue;
    map[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return map;
}

/**
 * Heuristic to skip Tailwind/utility class names so semantic classes survive
 * under the inventory cap. Errs on the side of dropping — if a class name
 * looks like a utility (color/spacing/typography/layout token), don't include
 * it. Semantic hooks whose names collide with utility prefixes (e.g.
 * `.grid-cell`, `.fill-blank`, `.text-input`, `.select-btn`, `.ring-carbon`)
 * are preserved by the caller when the same class is declared in the page's
 * own `<style>` block.
 */
// Common Tailwind category prefixes. Anchored with `-` so we don't match
// e.g. `.flex-container` (semantic) — Tailwind's `flex` is bare, and its
// modifiers are `flex-col`, `flex-1`, `flex-wrap` etc.
const UTILITY_PREFIXES = [
  'p-',
  'px-',
  'py-',
  'pt-',
  'pr-',
  'pb-',
  'pl-',
  'm-',
  'mx-',
  'my-',
  'mt-',
  'mr-',
  'mb-',
  'ml-',
  'w-',
  'h-',
  'min-w-',
  'min-h-',
  'max-w-',
  'max-h-',
  'text-',
  'font-',
  'leading-',
  'tracking-',
  'bg-',
  'border-',
  'ring-',
  'shadow-',
  'opacity-',
  'rounded-',
  'divide-',
  'space-',
  'gap-',
  'grid-',
  'col-',
  'row-',
  'top-',
  'right-',
  'bottom-',
  'left-',
  'inset-',
  'z-',
  'order-',
  'flex-',
  'items-',
  'justify-',
  'content-',
  'self-',
  'place-',
  'overflow-',
  'whitespace-',
  'break-',
  'transition-',
  'duration-',
  'ease-',
  'delay-',
  'animate-',
  'translate-',
  'rotate-',
  'scale-',
  'skew-',
  'origin-',
  'cursor-',
  'select-',
  'pointer-events-',
  'accent-',
  'caret-',
  'fill-',
  'stroke-',
  'aspect-',
];
// Exact single-token Tailwind utilities (no dash).
const UTILITY_EXACT = new Set([
  'flex',
  'grid',
  'block',
  'inline',
  'inline-block',
  'inline-flex',
  'hidden',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'static',
  'container',
  'italic',
  'underline',
  'uppercase',
  'lowercase',
  'capitalize',
  'truncate',
  'antialiased',
  'subpixel-antialiased',
  'visible',
  'invisible',
  'sr-only',
  'not-sr-only',
]);

function isUtilityClass(cls: string): boolean {
  // Responsive / state prefix (`md:`, `hover:`, `dark:foo`) → always utility.
  if (cls.includes(':')) return true;
  // Arbitrary-value utilities: `w-[240px]`, `text-[10px]`.
  if (cls.includes('[')) return true;
  if (UTILITY_PREFIXES.some((p) => cls.startsWith(p))) return true;
  return UTILITY_EXACT.has(cls);
}

/**
 * Step 3.2: Generate Actions based on content and script
 */
export async function generateSceneActions(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent,
  aiCall: AICallFn,
  options: SceneActionsOptions = {},
): Promise<Action[]> {
  const { ctx, agents, userProfile, languageDirective } = options;
  const agentsText = formatAgentsForPrompt(agents);

  // Debug: Log content type for interactive scenes
  if (outline.type === 'interactive') {
    const hasHtml = 'html' in content;
    log.info(
      `[Actions Gen] Interactive "${outline.title}": hasHtml=${hasHtml}, widgetType=${hasHtml ? content.widgetType : 'N/A'}`,
    );
  }

  if (outline.type === 'slide' && 'elements' in content) {
    // Format element list for AI to select from
    const elementsText = formatElementsForPrompt(content.elements);

    const prompts = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      elements: elementsText,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      userProfile: userProfile || '',
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultSlideActions(outline, content.elements);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(response, outline.type);

    if (actions.length > 0) {
      // Validate and fill in Action IDs
      return processActions(actions, content.elements, agents);
    }

    return generateDefaultSlideActions(outline, content.elements);
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    // Format question list for AI reference
    const questionsText = formatQuestionsForPrompt(content.questions);

    const prompts = buildPrompt(PROMPT_IDS.QUIZ_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      questions: questionsText,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultQuizActions(outline);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(response, outline.type);

    if (actions.length > 0) {
      return processActions(actions, [], agents);
    }

    return generateDefaultQuizActions(outline);
  }

  if (outline.type === 'interactive' && 'html' in content) {
    const config = outline.interactiveConfig;
    const agentsText = formatAgentsForPrompt(agents);
    // Always recompute the inventory from the current html so it matches what
    // the tool actually reads — persisting the field would go stale relative
    // to `postProcessInteractiveHtml` output and to any in-turn html edits.
    const inventory =
      (content.html ? extractInteractiveElements(content.html) : '') ||
      '(no interactive elements detected)';
    const prompts = buildPrompt(PROMPT_IDS.INTERACTIVE_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      conceptName: config?.conceptName || outline.title,
      designIdea: config?.designIdea || '',
      widgetType: content.widgetType || outline.widgetType || '',
      widgetConfig: JSON.stringify(content.widgetConfig || {}),
      elementInventory: inventory,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultInteractiveActions(outline);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(
      response,
      outline.type,
      INTERACTIVE_WIDGET_ACTIONS,
    );

    if (actions.length > 0) {
      return processActions(actions, [], agents);
    }

    return generateDefaultInteractiveActions(outline);
  }

  if (outline.type === 'pbl' && 'projectConfig' in content) {
    const pblConfig = outline.pblConfig;
    const agentsText = formatAgentsForPrompt(agents);
    const prompts = buildPrompt(PROMPT_IDS.PBL_ACTIONS, {
      title: outline.title,
      keyPoints: (outline.keyPoints || []).map((p, i) => `${i + 1}. ${p}`).join('\n'),
      description: outline.description,
      projectTopic: pblConfig?.projectTopic || outline.title,
      projectDescription: pblConfig?.projectDescription || outline.description,
      courseContext: buildCourseContext(ctx),
      agents: agentsText,
      languageDirective: languageDirective || '',
    });

    if (!prompts) {
      return generateDefaultPBLActions(outline);
    }

    const response = await aiCall(prompts.system, prompts.user);
    const actions = parseActionsFromStructuredOutput(response, outline.type);

    if (actions.length > 0) {
      return processActions(actions, [], agents);
    }

    return generateDefaultPBLActions(outline);
  }

  return [];
}

/**
 * Generate default PBL Actions (fallback)
 */
function generateDefaultPBLActions(_outline: SceneOutline): Action[] {
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: 'PBL 项目介绍',
      text: '现在让我们开始一个项目式学习活动。请选择你的角色，查看任务看板，开始协作完成项目。',
    },
  ];
}

/**
 * Format element list for AI to select elementId
 */
function formatElementsForPrompt(elements: PPTElement[]): string {
  return elements
    .map((el) => {
      let summary = '';
      if (el.type === 'text' && 'content' in el) {
        // Extract text content summary (strip HTML tags)
        const textContent = ((el.content as string) || '').replace(/<[^>]*>/g, '').substring(0, 50);
        summary = `Content summary: "${textContent}${textContent.length >= 50 ? '...' : ''}"`;
      } else if (el.type === 'chart' && 'chartType' in el) {
        summary = `Chart type: ${el.chartType}`;
      } else if (el.type === 'image') {
        summary = 'Image element';
      } else if (el.type === 'shape' && 'shapeName' in el) {
        summary = `Shape: ${el.shapeName || 'unknown'}`;
      } else if (el.type === 'latex' && 'latex' in el) {
        summary = `Formula: ${((el.latex as string) || '').substring(0, 30)}`;
      } else {
        summary = `${el.type} element`;
      }
      return `- id: "${el.id}", type: "${el.type}", ${summary}`;
    })
    .join('\n');
}

/**
 * Format question list for AI reference
 */
function formatQuestionsForPrompt(questions: QuizQuestion[]): string {
  return questions
    .map((q, i) => {
      const optionsText = q.options
        ? `Options: ${q.options.map((o) => `${o.value}. ${o.label}`).join(', ')}`
        : '';
      return `Q${i + 1} (${q.type}): ${q.question}\n${optionsText}`;
    })
    .join('\n\n');
}

/**
 * Process and validate Actions
 */
function processActions(actions: Action[], elements: PPTElement[], agents?: AgentInfo[]): Action[] {
  const elementIds = new Set(elements.map((el) => el.id));
  const agentIds = new Set(agents?.map((a) => a.id) || []);
  const studentAgents = agents?.filter((a) => a.role === 'student') || [];
  const nonTeacherAgents = agents?.filter((a) => a.role !== 'teacher') || [];

  return actions.map((action) => {
    // Ensure each action has an ID
    const processedAction: Action = {
      ...action,
      id: action.id || `action_${nanoid(8)}`,
    };

    // Validate spotlight elementId
    if (processedAction.type === 'spotlight') {
      const spotlightAction = processedAction;
      if (!spotlightAction.elementId || !elementIds.has(spotlightAction.elementId)) {
        // If elementId is invalid, try selecting the first element
        if (elements.length > 0) {
          spotlightAction.elementId = elements[0].id;
          log.warn(
            `Invalid elementId, falling back to first element: ${spotlightAction.elementId}`,
          );
        }
      }
    }

    // Validate/fill discussion agentId
    if (processedAction.type === 'discussion' && agents && agents.length > 0) {
      if (processedAction.agentId && agentIds.has(processedAction.agentId)) {
        // agentId valid — keep it
      } else {
        // agentId missing or invalid — pick a random student, or non-teacher, or skip
        const pool = studentAgents.length > 0 ? studentAgents : nonTeacherAgents;
        if (pool.length > 0) {
          const picked = pool[Math.floor(Math.random() * pool.length)];
          log.warn(
            `Discussion agentId "${processedAction.agentId || '(none)'}" invalid, assigned: ${picked.id} (${picked.name})`,
          );
          processedAction.agentId = picked.id;
        }
      }
    }

    return processedAction;
  });
}

/**
 * Generate default slide Actions (fallback)
 */
function generateDefaultSlideActions(outline: SceneOutline, elements: PPTElement[]): Action[] {
  const actions: Action[] = [];

  // Add spotlight for text elements
  const textElements = elements.filter((el) => el.type === 'text');
  if (textElements.length > 0) {
    actions.push({
      id: `action_${nanoid(8)}`,
      type: 'spotlight',
      title: '聚焦重点',
      elementId: textElements[0].id,
    });
  }

  // Add opening speech based on key points
  const speechText = outline.keyPoints?.length
    ? outline.keyPoints.join('。') + '。'
    : outline.description || outline.title;
  actions.push({
    id: `action_${nanoid(8)}`,
    type: 'speech',
    title: '场景讲解',
    text: speechText,
  });

  return actions;
}

/**
 * Generate default quiz Actions (fallback)
 */
function generateDefaultQuizActions(_outline: SceneOutline): Action[] {
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: '测验引导',
      text: '现在让我们来做一个小测验，检验一下学习成果。',
    },
  ];
}

/**
 * Generate default interactive Actions (fallback)
 */
function generateDefaultInteractiveActions(_outline: SceneOutline): Action[] {
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: '交互引导',
      text: '现在让我们通过交互式可视化来探索这个概念。请尝试操作页面中的元素，观察变化。',
    },
  ];
}

/**
 * Create a complete scene with Actions
 */
export function createSceneWithActions(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent,
  actions: Action[],
  api: ReturnType<typeof createStageAPI>,
): string | null {
  if (outline.type === 'slide' && 'elements' in content) {
    // Build complete Slide object
    const defaultTheme: SlideTheme = {
      backgroundColor: '#ffffff',
      themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
      outline: { color: '#d14424', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
    };

    const slide: Slide = {
      id: nanoid(),
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: defaultTheme,
      elements: content.elements,
      background: content.background,
    };

    const sceneResult = api.scene.create({
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'slide',
        canvas: slide,
      },
      actions,
      outlineId: outline.id,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    const sceneResult = api.scene.create({
      type: 'quiz',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'quiz',
        questions: content.questions,
      },
      actions,
      outlineId: outline.id,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  if (outline.type === 'interactive' && 'html' in content) {
    const sceneResult = api.scene.create({
      type: 'interactive',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'interactive',
        url: '',
        html: content.html,
        // Ultra Mode widget fields
        widgetType: content.widgetType,
        widgetConfig: content.widgetConfig,
      },
      actions,
      outlineId: outline.id,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  if (outline.type === 'pbl' && 'projectConfig' in content) {
    const sceneResult = api.scene.create({
      type: 'pbl',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'pbl',
        projectConfig: content.projectConfig,
        ...(content.projectV2 ? { projectV2: content.projectV2 } : {}),
      },
      actions,
      outlineId: outline.id,
    });

    return sceneResult.success ? (sceneResult.data ?? null) : null;
  }

  return null;
}
