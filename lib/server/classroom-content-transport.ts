import { Output, type LanguageModel, type Schema } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';

export const CLASSROOM_CONTENT_MAX_OUTPUT_TOKENS = 4096;

function isConfiguredDeepSeekChat(model?: LanguageModel): boolean {
  return (
    typeof model === 'object' &&
    model !== null &&
    'provider' in model &&
    model.provider === 'openai.chat' &&
    'modelId' in model &&
    model.modelId === 'deepseek-ai/DeepSeek-V4-Flash'
  );
}

/**
 * Only the complete-content review/repair caller uses these bounded options.
 * Thinking control is resolved independently by the actual provider adapter;
 * a gateway's reasoning_effort contract must not be guessed from its model name.
 * The optional model argument remains compatible with existing callers.
 */
export function getClassroomContentOutputOptions(
  _model?: LanguageModel,
  responseSchema?: Schema<unknown>,
) {
  return {
    output: responseSchema
      ? Output.object({ schema: responseSchema, name: 'classroom_content_response' })
      : Output.json(),
    maxOutputTokens: CLASSROOM_CONTENT_MAX_OUTPUT_TOKENS,
  };
}

/**
 * Internal scope is carried only by the complete-content review/repair getter.
 * It is not part of public ThinkingConfig, UI settings or global model config.
 */
type ClassroomContentThinkingConfig = ThinkingConfig & {
  readonly compatRequestScope?: 'classroom-content-review';
};

/** Preserve every other model's operator-configured per-call thinking. */
export function getClassroomContentThinkingConfig(
  model: LanguageModel,
  configuredThinking?: ThinkingConfig,
): ClassroomContentThinkingConfig | undefined {
  return isConfiguredDeepSeekChat(model)
    ? {
        mode: 'enabled',
        enabled: true,
        effort: 'high',
        compatRequestScope: 'classroom-content-review',
      }
    : configuredThinking;
}
