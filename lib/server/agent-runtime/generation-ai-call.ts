import type { AICallFn } from '@openmaic/generation';

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
}): (stage: LlmStage) => AICallFn {
  const calls = new Map<LlmStage, AICallFn>();
  return (stage) => {
    const cached = calls.get(stage);
    if (cached) return cached;
    let resolved: Awaited<ReturnType<typeof resolveModel>> | undefined;
    const call: AICallFn = async (systemPrompt, userPrompt) => {
      resolved ??= await resolveModel({ stage });
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
      );
      return result.text;
    };
    calls.set(stage, call);
    return call;
  };
}
