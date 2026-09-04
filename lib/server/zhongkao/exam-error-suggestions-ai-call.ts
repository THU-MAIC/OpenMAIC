import type { AICallFn } from '@openmaic/generation';

import { callLLM } from '@/lib/ai/llm';
import { resolveModel, type ResolvedModel } from '@/lib/server/resolve-model';

import {
  EXAM_ERROR_SUGGESTION_MODEL_STAGE,
  type ExamErrorSuggestionUsedModelExecutionV1,
} from './exam-error-suggestions-private';

export interface ExamErrorSuggestionAiCallBinding {
  call: AICallFn;
  getModelExecution: () => ExamErrorSuggestionUsedModelExecutionV1 | undefined;
}

export function createExamErrorSuggestionAiCall(options: {
  abortSignal?: AbortSignal;
  maxOutputTokens: number;
}): ExamErrorSuggestionAiCallBinding {
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) {
    throw new RangeError('maxOutputTokens must be a positive safe integer');
  }

  let resolvedPromise: Promise<ResolvedModel> | undefined;
  let modelExecution: ExamErrorSuggestionUsedModelExecutionV1 | undefined;
  const resolveOnce = (): Promise<ResolvedModel> => {
    resolvedPromise ??= resolveModel({ stage: EXAM_ERROR_SUGGESTION_MODEL_STAGE });
    return resolvedPromise;
  };

  const call: AICallFn = async (systemPrompt, userPrompt) => {
    const resolved = await resolveOnce();
    modelExecution ??= {
      status: 'used',
      stage: EXAM_ERROR_SUGGESTION_MODEL_STAGE,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
    };
    const modelMaxOutputTokens = resolved.modelInfo?.outputWindow;
    const maxOutputTokens =
      typeof modelMaxOutputTokens === 'number' &&
      Number.isSafeInteger(modelMaxOutputTokens) &&
      modelMaxOutputTokens >= 1
        ? Math.min(options.maxOutputTokens, modelMaxOutputTokens)
        : options.maxOutputTokens;
    const result = await callLLM(
      {
        model: resolved.model,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens,
        maxRetries: 0,
        abortSignal: options.abortSignal,
      },
      EXAM_ERROR_SUGGESTION_MODEL_STAGE,
      undefined,
      resolved.thinkingConfig,
    );
    return result.text;
  };

  return {
    call,
    getModelExecution: () =>
      modelExecution
        ? ({ ...modelExecution } as ExamErrorSuggestionUsedModelExecutionV1)
        : undefined,
  };
}
