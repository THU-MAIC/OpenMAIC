/**
 * App adapters around the store-independent @openmaic/generation scene layer.
 */

import type { LanguageModel } from 'ai';
import {
  applyOutlineFallbacks,
  buildCompleteScene,
  buildLanguageText,
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type AgentInfo,
  type ImageMapping,
  type PdfImage,
  type SceneGenerationContext,
  type SceneOutline,
} from '@openmaic/generation';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('Generation');

/** Generate both halves and assemble a store-independent app scene. */
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
  languageDirective?: string,
): Promise<Scene | null> {
  const safeOutline = applyOutlineFallbacks(outline, !!languageModel, { logger: log });
  const langText = buildLanguageText(languageDirective, safeOutline.languageNote);

  onPhaseChange?.('content');
  const content = await generateSceneContent(safeOutline, aiCall, {
    assignedImages,
    imageMapping,
    visionEnabled,
    agents,
    languageDirective: langText,
    logger: log,
    ...(languageModel
      ? {
          pblLoopFallback: (input) =>
            generatePBLV2Project(input, languageModel, callLLM, { logger: log }),
        }
      : {}),
  });
  if (!content) return null;

  onPhaseChange?.('actions');
  const actions = await generateSceneActions(safeOutline, content, aiCall, {
    ctx,
    agents,
    userProfile,
    languageDirective: langText,
    logger: log,
  });

  return buildCompleteScene(safeOutline, content, actions, stageId) as Scene | null;
}
