import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';

import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { ModelConfigurationError } from '@/lib/server/model-config/llm';

function providerError(statusCode: number) {
  return new APICallError({
    message: 'provider said no',
    url: 'https://provider.example/v1/chat',
    requestBodyValues: {},
    statusCode,
  });
}

describe('run failure codes', () => {
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
