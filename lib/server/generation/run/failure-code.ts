/**
 * The error code of a failed step, as the 1.1.x generation routes answered the
 * same failure, so a client shows the same sentence for it as it did when it
 * called those routes itself.
 */
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import { AudioProviderError } from '@/lib/audio/provider-error';
import { isUpstreamQuotaExhausted, upstreamHttpStatus } from '@/lib/server/llm-error-response';
import { ModelConfigurationError } from '@/lib/server/model-config/llm';
import { WebSearchConfigError } from '@/lib/server/web-search-config';

import { StepRefusal } from '../steps/context';

/** Public codes include adapter-owned actionable failures; never raw provider bodies. */
export type RunFailureErrorCode = RunFailureCode['errorCode'];

export interface RunFailureCode {
  errorCode: string;
  /**
   * Status used to classify the failure. A provider HTTP status when the
   * failure carries one. `TTSRateLimitError` contributes 429 as a classifier
   * sentinel even when the provider answered HTTP 200 with a rate-limit
   * business code; it is not that wire status.
   */
  statusCode?: number;
}

export function runFailureCode(error: unknown): RunFailureCode {
  if (error instanceof AudioProviderError && error.audioFailureKind === 'voice-incompatible')
    return { errorCode: error.code, statusCode: error.httpStatus };
  if (error instanceof ModelAuthorizationError)
    return { errorCode: error.code, statusCode: error.httpStatus };
  if (error instanceof ModelConfigurationError || error instanceof WebSearchConfigError) {
    return { errorCode: error.code };
  }
  // A step that refused its own output (no usable content): the content and
  // actions routes answer it as GENERATION_FAILED.
  if (error instanceof StepRefusal) return { errorCode: 'GENERATION_FAILED' };
  const status = upstreamHttpStatus(error);
  // The provider account's plan or balance, not the owner's quota: a host's
  // own quota failure has the code its `classifyFailure` answers.
  if (isUpstreamQuotaExhausted(error)) {
    return {
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      ...(status !== undefined ? { statusCode: status } : {}),
    };
  }
  if (status !== undefined) {
    return { errorCode: status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', statusCode: status };
  }
  return { errorCode: 'INTERNAL_ERROR' };
}
