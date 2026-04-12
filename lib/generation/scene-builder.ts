/**
 * Standalone scene building and element normalization.
 * Does NOT depend on store — returns complete Scene objects.
 */

import { nanoid } from 'nanoid';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  PdfImage,
  ImageMapping,
} from '@/lib/types/generation';
import type { LanguageModel } from 'ai';
import type { Slide, SlideTheme } from '@/lib/types/slides';
import type { Scene } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import { applyOutlineFallbacks } from './outline-generator';
import { generateSceneContent, generateSceneActions } from './scene-generator';
import type { AgentInfo, SceneGenerationContext, AICallFn } from './pipeline-types';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

/**
 * Replace sequential gen_img_N / gen_vid_N IDs in outlines with globally unique IDs.
 *
 * The LLM generates sequential placeholder IDs (gen_img_1, gen_img_2, ...) which are
 * only unique within a single course. Since the media store uses elementId as key
 * without stageId scoping, identical IDs across different courses cause thumbnail
 * contamination on the homepage. Using nanoid-based IDs ensures global uniqueness.
 */
export function uniquifyMediaElementIds(outlines: SceneOutline[]): SceneOutline[] {
  const idMap = new Map<string, string>();

  // First pass: collect all sequential media IDs and assign unique replacements
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      if (!idMap.has(mg.elementId)) {
        const prefix = mg.type === 'video' ? 'gen_vid_' : 'gen_img_';
        idMap.set(mg.elementId, `${prefix}${nanoid(8)}`);
      }
    }
  }

  if (idMap.size === 0) return outlines;

  // Second pass: replace IDs in mediaGenerations
  return outlines.map((outline) => {
    if (!outline.mediaGenerations) return outline;
    return {
      ...outline,
      mediaGenerations: outline.mediaGenerations.map((mg) => ({
        ...mg,
        elementId: idMap.get(mg.elementId) || mg.elementId,
      })),
    };
  });
}

/**
 * Build a complete Scene object from an outline (for SSE streaming)
 * This function does NOT depend on store - it returns a complete Scene object
 */
export async function buildSceneFromOutline(
  outline: SceneOutline,
  aiCall: AICallFn,
  stageId: string,
  assignedImages?: PdfImage[],
  imageMapping?: ImageMapping,
  languageModel?: LanguageModel,
  visionEnabled?: boolean,
  ctx?: SceneGenerationContext,
  agents?: AgentInfo[],
  onPhaseChange?: (phase: 'content' | 'actions') => void,
  userProfile?: string,
): Promise<Scene | null> {
  // Apply type fallbacks
  outline = applyOutlineFallbacks(outline, !!languageModel);

  // Step 1: Generate content (with images if available)
  onPhaseChange?.('content');
  log.debug(`Step 1: Generating content for: ${outline.title}`);
  if (assignedImages && assignedImages.length > 0) {
    log.debug(
      `Using ${assignedImages.length} assigned images: ${assignedImages.map((img) => img.id).join(', ')}`,
    );
  }
  log.debug(
    `imageMapping available: ${imageMapping ? Object.keys(imageMapping).length + ' keys' : 'undefined'}`,
  );
  const content = await generateSceneContent(outline, aiCall, {
    assignedImages,
    imageMapping,
    languageModel,
    visionEnabled,
    agents,
  });
  if (!content) {
    log.error(`Failed to generate content for: ${outline.title}`);
    return null;
  }

  // Step 2: Generate Actions
  onPhaseChange?.('actions');
  log.debug(`Step 2: Generating actions for: ${outline.title}`);
  const actions = await generateSceneActions(outline, content, aiCall, {
    ctx,
    agents,
    userProfile,
  });
  log.debug(`Generated ${actions.length} actions for: ${outline.title}`);

  // Build complete Scene object
  return buildCompleteScene(outline, content, actions, stageId);
}

/**
 * Build complete Scene object (without API/store)
 */
export function buildCompleteScene(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent,
  actions: Action[],
  stageId: string,
): Scene | null {
  const sceneId = nanoid();

  if (outline.type === 'slide' && 'elements' in content) {
    // Build Slide object
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

    return {
      id: sceneId,
      stageId,
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'slide',
        canvas: slide,
      },
      actions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    return {
      id: sceneId,
      stageId,
      type: 'quiz',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'quiz',
        questions: content.questions,
      },
      actions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  if (outline.type === 'interactive' && 'html' in content) {
    return {
      id: sceneId,
      stageId,
      type: 'interactive',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'interactive',
        url: '',
        html: content.html,
      },
      actions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  if (outline.type === 'pbl' && 'projectConfig' in content) {
    return {
      id: sceneId,
      stageId,
      type: 'pbl',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'pbl',
        projectConfig: content.projectConfig,
      },
      actions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  return null;
}
