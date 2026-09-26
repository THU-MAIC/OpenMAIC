import { describe, expect, it, vi, beforeEach } from 'vitest';
import { APICallError, RetryError } from 'ai';
import {
  isRetryableLlmError,
  isEmptyLlmOutput,
  shouldFallbackFor,
} from '@/lib/server/llm-fallback';

// Real AI SDK error instances (not plain Errors), so the classification can
// never regress against what generateText/streamText actually throw.

function apiError(statusCode: number, message: string, isRetryable?: boolean): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseBody: '',
    isRetryable,
  });
}

function networkError(message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    cause: new TypeError('fetch failed'),
  });
}

function retryError(inner: unknown): RetryError {
  return new RetryError({
    message: `Failed after 3 attempts. Last error: ${String(inner)}`,
    reason: 'maxRetriesExceeded',
    errors: [inner],
  });
}

describe('isRetryableLlmError (real AI SDK errors)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('unwraps a RetryError to its last APICallError (default maxRetries path)', () => {
    // After the SDK's own retries, 429/5xx surface as AI_RetryError with the
    // real APICallError in lastError/errors[] and no statusCode of its own.
    expect(isRetryableLlmError(retryError(apiError(429, 'quota exceeded', true)))).toBe(true);
    expect(isRetryableLlmError(retryError(apiError(503, 'model overloaded', true)))).toBe(true);
    expect(isRetryableLlmError(retryError(apiError(500, 'internal error', true)))).toBe(true);
    expect(isRetryableLlmError(retryError(apiError(408, 'request timeout', true)))).toBe(true);
  });

  it('never falls back through a RetryError wrapping content-safety or auth 4xx', () => {
    expect(isRetryableLlmError(retryError(apiError(400, 'content policy violation', false)))).toBe(
      false,
    );
    expect(isRetryableLlmError(retryError(apiError(401, 'unauthorized', false)))).toBe(false);
    expect(isRetryableLlmError(retryError(apiError(403, 'forbidden', false)))).toBe(false);
  });

  it('trusts the SDK isRetryable flag on a bare APICallError (maxRetries=0 path)', () => {
    expect(isRetryableLlmError(apiError(429, 'quota', true))).toBe(true);
    expect(isRetryableLlmError(apiError(408, 'timeout', true))).toBe(true);
    expect(isRetryableLlmError(apiError(400, 'bad request', false))).toBe(false);
    expect(isRetryableLlmError(apiError(401, 'unauthorized', false))).toBe(false);
  });

  it('falls back to status codes (408/409/429/>=500) when the flag is unset', () => {
    expect(isRetryableLlmError(apiError(408, 'request timeout'))).toBe(true);
    expect(isRetryableLlmError(apiError(409, 'conflict'))).toBe(true);
    expect(isRetryableLlmError(apiError(429, 'quota'))).toBe(true);
    expect(isRetryableLlmError(apiError(500, 'internal error'))).toBe(true);
    expect(isRetryableLlmError(apiError(502, 'bad gateway'))).toBe(true);
    expect(isRetryableLlmError(apiError(503, 'overloaded'))).toBe(true);
    expect(isRetryableLlmError(apiError(504, 'gateway timeout'))).toBe(true);
    expect(isRetryableLlmError(apiError(400, 'bad request'))).toBe(false);
    expect(isRetryableLlmError(apiError(404, 'not found'))).toBe(false);
  });

  it('treats "Cannot connect to API" transport failures as retryable', () => {
    expect(isRetryableLlmError(networkError('Cannot connect to API: connect ECONNRESET'))).toBe(
      true,
    );
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isRetryableLlmError(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })),
    ).toBe(true);
    expect(
      isRetryableLlmError(Object.assign(new Error('UND_ERR_SOCKET'), { code: 'UND_ERR_SOCKET' })),
    ).toBe(true);
  });

  it('is conservative with unknown non-AI errors and programming errors', () => {
    expect(isRetryableLlmError(new Error('something else went wrong'))).toBe(false);
    expect(isRetryableLlmError(new TypeError('x is not a function'))).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
    expect(isRetryableLlmError('not an error')).toBe(false);
  });
});

describe('isEmptyLlmOutput', () => {
  it('treats only truly empty or whitespace-only text as empty', () => {
    expect(isEmptyLlmOutput('')).toBe(true);
    expect(isEmptyLlmOutput('   ')).toBe(true);
    expect(isEmptyLlmOutput('\n\t ')).toBe(true);
    expect(isEmptyLlmOutput(null)).toBe(true);
    expect(isEmptyLlmOutput(undefined)).toBe(true);
    expect(isEmptyLlmOutput('ok')).toBe(false);
    expect(isEmptyLlmOutput(' {json} ')).toBe(false);
  });
});

describe('shouldFallbackFor', () => {
  it('delegates error decisions to isRetryableLlmError and ignores the text', () => {
    expect(shouldFallbackFor(apiError(429, 'quota', true), 'ok')).toBe(true);
    expect(shouldFallbackFor(apiError(400, 'content policy', false), 'ok')).toBe(false);
  });

  it('only falls back on empty output when no error is present', () => {
    expect(shouldFallbackFor(undefined, '')).toBe(true);
    expect(shouldFallbackFor(undefined, '   ')).toBe(true);
    // A non-empty output that failed a custom validator must NOT fall back.
    expect(shouldFallbackFor(undefined, '[not valid json]')).toBe(false);
    expect(shouldFallbackFor(undefined, 'valid-looking output')).toBe(false);
  });
});
