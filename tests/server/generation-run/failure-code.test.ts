import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';

import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { ModelConfigurationError } from '@/lib/server/model-config/llm';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';

function providerError(statusCode: number, body?: unknown) {
  return new APICallError({
    message: 'provider said no',
    url: 'https://provider.example/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseBody: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('run failure codes', () => {
  it.each([
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_usage_limit_exceeded',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
  ])('distinguishes the explicit %s quota code from temporary throttling', (code) => {
    expect(runFailureCode(providerError(429, { error: { code } }))).toEqual({
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      statusCode: 429,
    });
  });

  it('recognizes the quota type in the SDK parsed error data', () => {
    const error = new APICallError({
      message: 'provider said no',
      url: 'https://provider.example/v1/chat',
      requestBodyValues: {},
      statusCode: 429,
      data: { error: { type: 'insufficient_quota', code: null } },
    });
    expect(runFailureCode(error)).toEqual({
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      statusCode: 429,
    });
  });

  it.each([1008, 2056])(
    'leaves a vendor-native code (%s) to its adapter, not the shared classification',
    (status_code) => {
      expect(runFailureCode(providerError(400, { base_resp: { status_code } }))).toEqual({
        errorCode: 'UPSTREAM_ERROR',
        statusCode: 400,
      });
    },
  );

  it('recognizes an adapter’s quota error, thrown or as the cause of the error it throws', () => {
    const quota = new ProviderQuotaExhaustedError('Example', 'Example API error (4711): no credit');
    expect(runFailureCode(quota)).toEqual({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
    expect(runFailureCode(new Error('Example rate limit exceeded', { cause: quota }))).toEqual({
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
    });
  });

  // A stream reports its error as a part, which the SDK passes on as it came.
  it.each([
    [
      'a Chat Completions stream error',
      { message: 'No credit', type: 'insufficient_quota', code: 'insufficient_quota' },
    ],
    [
      'a Responses error event',
      { type: 'error', sequence_number: 0, message: 'No credit', code: 'insufficient_quota' },
    ],
    [
      'a Responses response.failed event',
      {
        type: 'response.failed',
        sequence_number: 0,
        response: { error: { message: 'No credit', code: 'insufficient_quota' } },
      },
    ],
  ])('recognizes the quota code in %s', (_label, part) => {
    expect(runFailureCode(new Error('stream failed', { cause: part }))).toEqual({
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
    });
  });

  it.each([
    ['a failed response without an error', { type: 'response.failed', response: { error: null } }],
    [
      'a rate-limit error event',
      { type: 'error', message: 'Slow down', code: 'rate_limit_exceeded' },
    ],
  ])('does not read %s as a quota refusal', (_label, part) => {
    expect(runFailureCode(new Error('stream failed', { cause: part }))).toEqual({
      errorCode: 'INTERNAL_ERROR',
    });
  });

  it('keeps the quota classification through SDK retries and an outer cause', () => {
    const retry = new RetryError({
      message: 'retry attempts exhausted',
      reason: 'maxRetriesExceeded',
      errors: [providerError(503), providerError(429, { error: { code: 'insufficient_quota' } })],
    });
    expect(runFailureCode(new Error('generation failed', { cause: retry }))).toEqual({
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      statusCode: 429,
    });
  });

  it('reports the last retry failure, not an earlier quota error', () => {
    const retry = new RetryError({
      message: 'retry attempts exhausted',
      reason: 'maxRetriesExceeded',
      errors: [providerError(429, { error: { code: 'insufficient_quota' } }), providerError(503)],
    });
    expect(runFailureCode(retry)).toEqual({ errorCode: 'UPSTREAM_ERROR', statusCode: 503 });
  });

  it.each([
    { error: { code: 'rate_limit_exceeded' } },
    { error: { code: 'RESOURCE_EXHAUSTED' } },
    { error: { message: 'quota exceeded; try again later' } },
    { error: { message: 'insufficient balance (1008)' } },
    { base_resp: { status_code: 1002 } },
    { base_resp: { status_code: 1039 } },
    { code: 2056 },
    null,
  ])('does not infer plan exhaustion from an ambiguous 429 body: %j', (body) => {
    expect(runFailureCode(providerError(429, body))).toEqual({
      errorCode: 'RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('keeps malformed and non-JSON provider responses as ordinary upstream failures', () => {
    const error = providerError(429);
    Object.assign(error, { responseBody: '<html>quota exceeded</html>' });
    expect(runFailureCode(error)).toEqual({ errorCode: 'RATE_LIMITED', statusCode: 429 });
  });

  it('answer a failure with the code the classic routes answered it with', () => {
    expect(runFailureCode(providerError(429))).toEqual({
      errorCode: 'RATE_LIMITED',
      statusCode: 429,
    });
    expect(runFailureCode(providerError(503))).toEqual({
      errorCode: 'UPSTREAM_ERROR',
      statusCode: 503,
    });
    expect(runFailureCode(providerError(401))).toEqual({
      errorCode: 'UPSTREAM_ERROR',
      statusCode: 401,
    });
    expect(runFailureCode(new StepRefusal('no-content', 'nothing usable'))).toEqual({
      errorCode: 'GENERATION_FAILED',
    });
    expect(runFailureCode(new ModelConfigurationError('MISSING_API_KEY', 'no key'))).toEqual({
      errorCode: 'MISSING_API_KEY',
    });
    expect(runFailureCode(new Error('socket hang up'))).toEqual({ errorCode: 'INTERNAL_ERROR' });
  });
});
