import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it } from 'vitest';

import { runFailureText } from '@/lib/generation-run-client/failure-message';
import { createLogger } from '@/lib/logger';
import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { generateOutlines, OutlineGenerationError } from '@/lib/server/generation/steps/outline';

function refused(code: string): Response {
  return Response.json(
    { error: { message: 'Provider request refused', type: code, code } },
    { status: 429, headers: { 'retry-after-ms': '1' } },
  );
}

/** Exercise the real adapter, SDK retries and outline step; only HTTP is replaced. */
async function failedOutline(fetch: typeof globalThis.fetch): Promise<unknown> {
  const model = createOpenAI({
    apiKey: 'test-key',
    baseURL: 'https://provider.example.test/v1',
    fetch,
  }).chat('gpt-4o-mini');
  try {
    await generateOutlines(
      {
        requirements: { requirement: 'Teach photosynthesis' },
        model: {
          model,
          modelInfo: null,
          modelString: 'openai:gpt-4o-mini',
          thinkingConfig: undefined,
          serverManaged: false,
        },
      },
      {
        log: createLogger('OutlineQuotaTest'),
        workspaceId: null,
        resolveVisionImages: async (images) => [...images],
      },
    );
  } catch (error) {
    return error;
  }
  throw new Error('Expected the outline generation to fail');
}

describe('an upstream refusal through outline generation', () => {
  it.each([
    ['insufficient_quota', 'QUOTA_EXHAUSTED'],
    ['rate_limit_exceeded', 'RATE_LIMITED'],
  ])('preserves %s for the run classifier after the existing retries', async (code, errorCode) => {
    let requests = 0;
    const failure = await failedOutline(async () => {
      requests += 1;
      return refused(code);
    });

    expect(failure).toBeInstanceOf(OutlineGenerationError);
    expect(runFailureCode(failure)).toEqual({ errorCode, statusCode: 429 });
    // Three outline attempts, each retaining the SDK's three attempts.
    expect(requests).toBe(9);
    if (errorCode === 'QUOTA_EXHAUSTED') {
      expect(
        runFailureText({ step: 'outline', message: String(failure), ...runFailureCode(failure) }),
      ).toEqual({
        key: 'generation.quotaExhausted',
      });
    }
  });

  it('does not retain an earlier quota refusal when later attempts return empty output', async () => {
    let requests = 0;
    const failure = await failedOutline(async () => {
      requests += 1;
      if (requests <= 3) return refused('insufficient_quota');
      return new Response(
        'data: {"id":"empty","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    expect(failure).toMatchObject({ message: 'LLM returned empty response' });
    expect(runFailureCode(failure)).toEqual({ errorCode: 'INTERNAL_ERROR' });
    expect(requests).toBe(5);
  });
});
