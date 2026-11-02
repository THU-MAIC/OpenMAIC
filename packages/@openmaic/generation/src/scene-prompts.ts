/**
 * Scene system prompts rendered from the packaged templates.
 */

import { buildPrompt, PROMPT_IDS } from './prompts/index.js';

/** Scene prompts that `renderScenePrompt` can render. */
export type ScenePromptId = typeof PROMPT_IDS.SLIDE_CONTENT;

/** Media rules to include in the slide content system prompt. */
export interface SlideContentPromptOptions {
  /** Image element rules: the slide has assigned images or generated images. */
  imageElementEnabled: boolean;
  /** Rules for AI-generated image placeholders. */
  generatedImageEnabled: boolean;
  /** Rules for AI-generated video placeholders. */
  generatedVideoEnabled: boolean;
}

/** The rendered system prompt of a scene. */
export interface RenderedScenePrompt {
  system: string;
}

// Canvas dimensions (matching viewportSize and viewportRatio).
const SLIDE_CANVAS_WIDTH = 1000;
const SLIDE_CANVAS_HEIGHT = 562.5;

/**
 * Build the slide content prompt. Internal: `generateSlideContent` and
 * `renderScenePrompt` both go through here, so the system prompt a consumer
 * renders is the one the slide generator sends to the model.
 */
export function buildSlideContentPrompt(
  options: SlideContentPromptOptions,
  userVariables: Record<string, unknown> = {},
): { system: string; user: string } | null {
  const { imageElementEnabled, generatedImageEnabled, generatedVideoEnabled } = options;
  return buildPrompt(PROMPT_IDS.SLIDE_CONTENT, {
    ...userVariables,
    canvas_width: SLIDE_CANVAS_WIDTH,
    canvas_height: SLIDE_CANVAS_HEIGHT,
    imageElementEnabled,
    generatedImageEnabled,
    generatedVideoEnabled,
    mediaElementEnabled: imageElementEnabled || generatedVideoEnabled,
  });
}

/**
 * Render the system prompt that scene content generation sends to the model.
 *
 * `'slide-content'` returns the slide generator's system prompt for the given
 * media flags, without running generation. Throws when the packaged template
 * cannot be loaded.
 */
export function renderScenePrompt(
  promptId: ScenePromptId,
  options: SlideContentPromptOptions,
): RenderedScenePrompt {
  const prompt = promptId === PROMPT_IDS.SLIDE_CONTENT ? buildSlideContentPrompt(options) : null;
  if (!prompt) throw new Error(`Scene prompt unavailable: ${promptId}`);
  return { system: prompt.system };
}
