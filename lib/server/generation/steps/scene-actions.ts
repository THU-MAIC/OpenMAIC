/**
 * Scene actions: generate the playback actions (speech, spotlights, ...) for
 * one scene from its outline and content, with the course context (the
 * scene's place among all outlines and the speeches of the scenes before it),
 * and assemble the complete scene. The logic of 1.1.x's
 * POST /api/generate/scene-actions.
 */
import { callLLM } from '@/lib/ai/llm';
import {
  generateSceneActions as generateActions,
  buildCompleteScene,
  buildVisionUserContent,
  type SceneGenerationContext,
  type AgentInfo,
} from '@openmaic/generation';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import type { PBLContent } from '@/lib/types/stage';
import { normalizeLegacyPBLContent } from '@/lib/pbl/legacy/read';

import { StepRefusal, type StepContext, type StepLanguageModel } from './context';

export interface SceneActionsInput {
  outline: SceneOutline;
  /** Every outline of the course, for the scene's page index and the titles around it. */
  allOutlines: SceneOutline[];
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent
    | PBLContent;
  stageId: string;
  agents?: AgentInfo[];
  /** What the scenes before this one said, for continuity. */
  previousSpeeches?: string[];
  userProfile?: string;
  languageDirective?: string;
  /** The scene-actions stage's model. */
  model: StepLanguageModel;
}

export type SceneActionsRefusal = 'assembly-failed';

export type GeneratedScene = NonNullable<ReturnType<typeof buildCompleteScene>>;

export interface SceneActionsResult {
  scene: GeneratedScene;
  /** This scene's speeches, for the scenes after it. */
  previousSpeeches: string[];
}

export async function generateSceneActions(
  input: SceneActionsInput,
  ctx: StepContext,
): Promise<SceneActionsResult> {
  const { outline, allOutlines, content, stageId, agents, userProfile, languageDirective } = input;
  const {
    model: languageModel,
    modelInfo,
    modelString,
    thinkingConfig,
    serverManaged,
  } = input.model;
  const { log } = ctx;

  // Detect vision capability
  const hasVision = !!modelInfo?.capabilities?.vision;

  // AI call function (actions typically don't use vision, but kept for consistency)
  const aiCall = async (
    systemPrompt: string,
    userPrompt: string,
    images?: Array<{ id: string; src: string }>,
  ): Promise<string> => {
    if (images?.length && hasVision) {
      const result = await callLLM(
        {
          model: languageModel,
          // A run cancels the call when it loses its lease or its course.
          abortSignal: ctx.signal,
          system: systemPrompt,
          messages: [
            {
              role: 'user' as const,
              content: buildVisionUserContent(userPrompt, images),
            },
          ],
          maxOutputTokens: modelInfo?.outputWindow,
          maxRetries: 0,
        },
        'scene-actions',
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
      'scene-actions',
      undefined,
      thinkingConfig,
      { serverManaged },
    );
    return result.text;
  };

  // ── Build cross-scene context ──
  const allTitles = allOutlines.map((o) => o.title);
  const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
  const generationCtx: SceneGenerationContext = {
    pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
    totalPages: allOutlines.length,
    allTitles,
    previousSpeeches: input.previousSpeeches ?? [],
  };

  // ── Generate actions ──
  log.info(`Generating actions: "${outline.title}" (${outline.type}) [model=${modelString}]`);

  const generationContent = (
    'type' in content && content.type === 'pbl' ? normalizeLegacyPBLContent(content) : content
  ) as
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent;

  const actions = await generateActions(outline, generationContent, aiCall, {
    ctx: generationCtx,
    agents,
    userProfile,
    languageDirective,
  });

  log.info(`Generated ${actions.length} actions for: "${outline.title}"`);

  // ── Build complete scene ──
  const scene = buildCompleteScene(outline, generationContent, actions, stageId);

  if (!scene) {
    log.error(`Failed to build scene: "${outline.title}"`);
    throw new StepRefusal<SceneActionsRefusal>(
      'assembly-failed',
      `Failed to build scene: ${outline.title}`,
    );
  }

  // ── Extract speeches for cross-scene coherence ──
  const previousSpeeches = (scene.actions || [])
    .filter((a): a is SpeechAction => a.type === 'speech')
    .map((a) => a.text);

  log.info(
    `Scene assembled successfully: "${outline.title}" — ${scene.actions?.length ?? 0} actions`,
  );

  return { scene, previousSpeeches };
}
