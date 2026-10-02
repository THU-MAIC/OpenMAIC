/**
 * The error code of a failed step, as the classic generation routes answered
 * the same failure (`llmApiError`, the routes' refusal mappings), so a client
 * shows the same sentence for it as it did when it called the routes itself.
 */
import { upstreamHttpStatus } from '@/lib/server/llm-error-response';
import { ModelConfigurationError } from '@/lib/server/model-config/llm';
import { WebSearchConfigError } from '@/lib/server/web-search-config';

import { StepRefusal } from '../steps/context';

export interface RunFailureCode {
  errorCode: string;
  /** The provider's HTTP status, when the failure is a provider's answer. */
  statusCode?: number;
}

export function runFailureCode(error: unknown): RunFailureCode {
  if (error instanceof ModelConfigurationError || error instanceof WebSearchConfigError) {
    return { errorCode: error.code };
  }
  // A step that refused its own output (no usable content): the content and
  // actions routes answer it as GENERATION_FAILED.
  if (error instanceof StepRefusal) return { errorCode: 'GENERATION_FAILED' };
  const status = upstreamHttpStatus(error);
  if (status !== undefined) {
    return { errorCode: status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', statusCode: status };
  }
  return { errorCode: 'INTERNAL_ERROR' };
}
