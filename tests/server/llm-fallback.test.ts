import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRetryableLlmError } from '@/lib/server/llm-fallback';

function apiError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'AI_APICallError', statusCode });
}

describe('isRetryableLlmError', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats quota and capacity rejections as retryable', () => {
    expect(isRetryableLlmError(apiError(429, 'You exceeded your current quota'))).toBe(true);
    expect(isRetryableLlmError(apiError(503, 'Model overloaded'))).toBe(true);
  });

  it('treats timeouts and server errors as retryable', () => {
    expect(isRetryableLlmError(apiError(408, 'request timeout'))).toBe(true);
    expect(isRetryableLlmError(apiError(500, 'internal error'))).toBe(true);
    expect(isRetryableLlmError(apiError(502, 'bad gateway'))).toBe(true);
    expect(isRetryableLlmError(apiError(504, 'gateway timeout'))).toBe(true);
  });

  it('never treats content-safety or other 4xx rejections as retryable', () => {
    expect(isRetryableLlmError(apiError(400, 'content policy violation'))).toBe(false);
    expect(isRetryableLlmError(apiError(401, 'unauthorized'))).toBe(false);
    expect(isRetryableLlmError(apiError(403, 'forbidden'))).toBe(false);
    expect(isRetryableLlmError(apiError(404, 'not found'))).toBe(false);
  });

  it('treats transport-level failures as retryable', () => {
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isRetryableLlmError(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })),
    ).toBe(true);
    expect(
      isRetryableLlmError(Object.assign(new Error('UND_ERR_SOCKET'), { code: 'UND_ERR_SOCKET' })),
    ).toBe(true);
  });

  it('is conservative with unknown non-AI errors', () => {
    expect(isRetryableLlmError(new Error('something else went wrong'))).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
    expect(isRetryableLlmError('not an error')).toBe(false);
  });
});
