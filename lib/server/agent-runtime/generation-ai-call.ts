import type { AICallFn } from '@openmaic/generation';

import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import { createGenerationAiCall } from '@/lib/server/generation/ai-call';
import type { LlmStage } from '@/lib/server/model-routes';
import { resolveModel } from '@/lib/server/resolve-model';

const CONTENT_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

export function sceneContentStage(type?: string): LlmStage {
  return type && CONTENT_TYPES.has(type) ? (`scene-content:${type}` as LlmStage) : 'scene-content';
}

/** Bind the generation package's neutral callback seam to server stage routing. */
export function createGenerationAiCallFactory(options?: {
  abortSignal?: AbortSignal;
  /** Whose model settings apply: the run's session owner. */
  ownerId?: string;
}): (stage: LlmStage) => AICallFn {
  const calls = new Map<LlmStage, AICallFn>();
  return (stage) => {
    const cached = calls.get(stage);
    if (cached) return cached;
    let aiCall: AICallFn | undefined;
    const call: AICallFn = async (systemPrompt, userPrompt) => {
      aiCall ??= createGenerationAiCall(
        await resolveModel({
          stage,
          workspaceId: options?.ownerId ? await backgroundWorkspaceId(options.ownerId) : null,
        }),
        stage,
        options,
      );
      return aiCall(systemPrompt, userPrompt);
    };
    calls.set(stage, call);
    return call;
  };
}
