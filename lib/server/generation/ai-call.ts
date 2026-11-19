import { buildVisionUserContent, type AICallFn } from '@openmaic/generation';

import { callLLM } from '@/lib/ai/llm';
import type { LlmStage } from '@/lib/server/model-routes';
import type { ResolvedModel } from '@/lib/server/resolve-model';
import type { VisionImageResolver } from './steps/context';

/** Adapt a resolved server model to the generation package's callback. */
export function createGenerationAiCall(
  {
    model,
    modelInfo,
    thinkingConfig,
    serverManaged,
  }: Pick<ResolvedModel, 'model' | 'modelInfo' | 'thinkingConfig' | 'serverManaged'>,
  source: LlmStage,
  options?: {
    abortSignal?: AbortSignal;
    resolveVisionImages?: VisionImageResolver;
  },
): AICallFn {
  const resolveImages = modelInfo?.capabilities?.vision ? options?.resolveVisionImages : undefined;
  return async (systemPrompt, userPrompt, images) => {
    const input =
      resolveImages && images?.length
        ? {
            messages: [
              {
                role: 'user' as const,
                content: buildVisionUserContent(userPrompt, await resolveImages(images)),
              },
            ],
          }
        : { prompt: userPrompt };
    const result = await callLLM(
      {
        model,
        system: systemPrompt,
        ...input,
        maxOutputTokens: modelInfo?.outputWindow,
        maxRetries: 0,
        abortSignal: options?.abortSignal,
      },
      source,
      undefined,
      thinkingConfig,
      { serverManaged },
    );
    return result.text;
  };
}
