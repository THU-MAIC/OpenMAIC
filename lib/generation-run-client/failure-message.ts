/**
 * What the preview says about the step a run paused at: the sentences the
 * browser showed when it called the generation routes itself, chosen by the
 * step and the error code the run recorded for it. The run's own message is
 * the fallback, as the route's message was. Also what the classroom says on
 * the failed scene's card.
 */
import type { GenerationRunFailure } from '@/lib/server/generation/run/types';

export type FailureText = { key: string; fallback?: string } | { text: string };

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function translateFailureText(text: FailureText, t: Translate): string {
  return 'key' in text ? t(text.key, { defaultValue: text.fallback }) : text.text;
}

/**
 * The guidance for a provider's exhausted plan or balance, in the preview and
 * in the classroom. A host's own quota code is the host's to word: its message
 * is kept.
 */
export function providerFailureText(failure: {
  errorCode?: string;
  messageKey?: string;
  message?: string;
}): FailureText | undefined {
  if (failure.errorCode === 'PROVIDER_ACTION_REQUIRED' && failure.message) {
    return failure.messageKey
      ? { key: failure.messageKey, fallback: failure.message }
      : { text: failure.message };
  }
  if (failure.errorCode === 'PROVIDER_QUOTA_EXHAUSTED') return { key: 'generation.quotaExhausted' };
}

/**
 * The guidance for the classroom's pending scene card, which shows the first
 * scene not yet produced. Only the scene the paused run stopped at gets it: a
 * scene the run went on past failed for its own reason and keeps the generic
 * text.
 */
export function pendingSceneFailureText(
  failure:
    | (Pick<GenerationRunFailure, 'errorCode' | 'messageKey'> & {
        readonly message?: string;
        readonly outlineId: string | null;
      })
    | null
    | undefined,
  pendingOutlineId: string | undefined,
): FailureText | undefined {
  if (!failure?.outlineId || failure.outlineId !== pendingOutlineId) return undefined;
  return providerFailureText(failure);
}

/** The classic mapping of a scene step's failure (content, actions) to a sentence. */
export function sceneFailureText(failure: {
  message?: string;
  errorCode?: string;
  messageKey?: string;
  statusCode?: number;
}): FailureText {
  const { errorCode, statusCode } = failure;
  const provider = providerFailureText(failure);
  if (provider) return provider;
  if (errorCode === 'MISSING_API_KEY' || statusCode === 401 || statusCode === 403) {
    return { key: 'generation.sceneGenerateAuthFailed' };
  }
  if (errorCode === 'RATE_LIMITED' || statusCode === 429) {
    return { key: 'generation.sceneGenerateRateLimited' };
  }
  if (errorCode === 'UPSTREAM_ERROR' && statusCode && statusCode >= 500) {
    return { key: 'generation.sceneGenerateProviderUnavailable' };
  }
  if (errorCode === 'INTERNAL_ERROR') return { key: 'generation.sceneGenerateFailed' };
  if (errorCode === 'GENERATION_FAILED') return { key: 'generation.sceneGenerateInvalidResponse' };
  return failure.message ? { text: failure.message } : { key: 'generation.sceneGenerateFailed' };
}

export function runFailureText(
  failure: Pick<
    GenerationRunFailure,
    'step' | 'message' | 'errorCode' | 'messageKey' | 'statusCode'
  >,
): FailureText {
  if (failure.errorCode === 'QWEN_VC_RECLONE_REQUIRED')
    return { key: 'generation.qwenCloneNewGenerationHint' };
  const provider = providerFailureText(failure);
  if (provider) return provider;
  const step = failure.step ?? '';
  if (step === 'material-analysis') return { key: 'generation.courseMaterialParseFailed' };
  if (step === 'research') {
    return failure.message ? { text: failure.message } : { key: 'generation.webSearchFailed' };
  }
  if (step === 'outline') {
    return failure.message
      ? { text: failure.message }
      : { key: 'generation.outlineGenerateFailed' };
  }
  if (/^scene:\d+:narration$/.test(step)) return { key: 'generation.speechFailed' };
  if (/^scene:\d+:(content|actions)$/.test(step)) return sceneFailureText(failure);
  return failure.message ? { text: failure.message } : { key: 'generation.sceneGenerateFailed' };
}
