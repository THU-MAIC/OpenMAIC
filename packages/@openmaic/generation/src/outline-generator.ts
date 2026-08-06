/**
 * Stage 1: Generate scene outlines from user requirements.
 * Also contains outline fallback logic.
 */

import { nanoid } from 'nanoid';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from './constants.js';
import { parseJsonResponse } from './json-repair.js';
import { noopGenerationLogger, type GenerationLogger } from './logger.js';
import {
  formatImageDescription,
  formatImagePlaceholder,
  sortDocumentImagesForVision,
} from './outline-formatters.js';
import { uniquifyMediaElementIds } from './outline-media.js';
import type { ImageMapping, PdfImage, SceneOutline, UserRequirements } from './outline-types.js';
import type { AICallFn, GenerationResult } from './pipeline-types.js';
import { buildPrompt, PROMPT_IDS } from './prompts/index.js';

export const DEFAULT_LANGUAGE_DIRECTIVE =
  'Teach in the language that matches the user requirement.';

export interface OutlinePromptContext {
  pdfText?: string;
  pdfImages?: PdfImage[];
  visionEnabled?: boolean;
  imageMapping?: ImageMapping;
  imageGenerationEnabled?: boolean;
  videoGenerationEnabled?: boolean;
  researchContext?: string;
  teacherContext?: string;
}

export interface OutlineGenerationOptions extends Omit<
  OutlinePromptContext,
  'pdfText' | 'pdfImages'
> {
  logger?: GenerationLogger;
}

export interface OutlineFallbackOptions {
  allowProceduralSkill?: boolean;
  logger?: GenerationLogger;
}

function buildAvailableImages(
  pdfImages: PdfImage[] | undefined,
  context: OutlinePromptContext,
): { availableImagesText: string; visionImages?: Array<{ id: string; src: string }> } {
  let availableImagesText = 'No images available';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (context.visionEnabled && context.imageMapping) {
      const sortedImages = sortDocumentImagesForVision(pdfImages);
      const allWithSrc = sortedImages.filter((image) => context.imageMapping![image.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedImages.filter((image) => !context.imageMapping![image.id]);

      const visionDescriptions = visionSlice.map((image) => formatImagePlaceholder(image));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((image) =>
        formatImageDescription(image),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((image) => ({
        id: image.id,
        src: context.imageMapping![image.id],
        width: image.width,
        height: image.height,
      }));
    } else {
      availableImagesText = pdfImages.map((image) => formatImageDescription(image)).join('\n');
    }
  }

  return { availableImagesText, visionImages };
}

/** Build the byte-stable system and user prompts for outline generation. */
export function buildOutlinePrompt(
  requirements: UserRequirements,
  context: OutlinePromptContext = {},
): { system: string; user: string } {
  const { pdfText, pdfImages } = context;
  const { availableImagesText } = buildAvailableImages(pdfImages, context);

  const userProfileText =
    requirements.userNickname || requirements.userBio
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
      : '';

  const imageEnabled = context.imageGenerationEnabled ?? false;
  const videoEnabled = context.videoGenerationEnabled ?? false;
  const mediaEnabled = imageEnabled || videoEnabled;
  const hasSourceImages = (pdfImages?.length ?? 0) > 0;

  const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement: requirements.requirement,
    pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
    availableImages: availableImagesText,
    userProfile: userProfileText,
    hasSourceImages,
    imageEnabled,
    videoEnabled,
    mediaEnabled,
    researchContext: context.researchContext || 'None',
    teacherContext: context.teacherContext || '',
  });

  if (!prompts) {
    throw new Error('Prompt template not found');
  }

  return prompts;
}

/** Generate scene outlines from user requirements. */
export async function generateSceneOutlinesFromRequirements(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  options?: OutlineGenerationOptions,
): Promise<
  GenerationResult<{ languageDirective: string; courseTitle?: string; outlines: SceneOutline[] }>
> {
  const logger = options?.logger ?? noopGenerationLogger;
  const context: OutlinePromptContext = { ...options, pdfText, pdfImages };
  let prompts: { system: string; user: string };

  try {
    prompts = buildOutlinePrompt(requirements, context);
  } catch (error) {
    if (error instanceof Error && error.message === 'Prompt template not found') {
      return { success: false, error: 'Prompt template not found' };
    }
    throw error;
  }

  const { visionImages } = buildAvailableImages(pdfImages, context);

  try {
    const response = await aiCall(prompts.system, prompts.user, visionImages);
    const parsed = parseJsonResponse<
      { languageDirective: string; courseTitle?: string; outlines: SceneOutline[] } | SceneOutline[]
    >(response, { logger });

    let languageDirective: string;
    let courseTitle: string | undefined;
    let rawOutlines: SceneOutline[];

    if (Array.isArray(parsed)) {
      languageDirective = DEFAULT_LANGUAGE_DIRECTIVE;
      rawOutlines = parsed;
    } else if (parsed && parsed.outlines) {
      languageDirective = parsed.languageDirective || DEFAULT_LANGUAGE_DIRECTIVE;
      const rawTitle = parsed.courseTitle;
      courseTitle =
        typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : undefined;
      rawOutlines = parsed.outlines;
    } else {
      return { success: false, error: 'Failed to parse scene outlines response' };
    }

    if (!Array.isArray(rawOutlines)) {
      return { success: false, error: 'Failed to parse scene outlines response' };
    }

    const enriched = rawOutlines.map((outline, index) => ({
      ...outline,
      id: outline.id || nanoid(),
      order: index + 1,
    }));

    const result = uniquifyMediaElementIds(enriched);

    return { success: true, data: { languageDirective, courseTitle, outlines: result } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function sanitizeProceduralSkillOutline(outline: SceneOutline): SceneOutline {
  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

export function applyOutlineFallbacks(
  outline: SceneOutline,
  hasLanguageModel: boolean,
  options: OutlineFallbackOptions = {},
): SceneOutline {
  const logger = options.logger ?? noopGenerationLogger;
  const hasWidgetConfig = outline.widgetType && outline.widgetOutline;

  if (outline.widgetType === 'procedural-skill' && !options.allowProceduralSkill) {
    logger.warn(
      `Procedural-skill outline "${outline.title}" is not enabled, falling back to diagram`,
    );
    return sanitizeProceduralSkillOutline(outline);
  }

  if (outline.type === 'interactive' && !outline.interactiveConfig && !hasWidgetConfig) {
    logger.warn(
      `Interactive outline "${outline.title}" missing interactiveConfig and widget config, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  if (outline.type === 'pbl' && (!outline.pblConfig || !hasLanguageModel)) {
    logger.warn(
      `PBL outline "${outline.title}" missing pblConfig or languageModel, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  return outline;
}
