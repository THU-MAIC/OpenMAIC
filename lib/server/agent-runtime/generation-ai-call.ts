import type { AICallFn } from '@openmaic/generation';

import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import { callLLM } from '@/lib/ai/llm';
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
    let resolved: Awaited<ReturnType<typeof resolveModel>> | undefined;
    const call: AICallFn = async (systemPrompt, userPrompt) => {
      resolved ??= await resolveModel({
        stage,
        workspaceId: options?.ownerId ? await backgroundWorkspaceId(options.ownerId) : null,
      });
      const result = await callLLM(
        {
          model: resolved.model,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: resolved.modelInfo?.outputWindow,
          maxRetries: 0,
          abortSignal: options?.abortSignal,
        },
        stage,
        undefined,
        resolved.thinkingConfig,
        { serverManaged: resolved.serverManaged },
      );
      return result.text;
    };
    calls.set(stage, call);
    return call;
  };
}
