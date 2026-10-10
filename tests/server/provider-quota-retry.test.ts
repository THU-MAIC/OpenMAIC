import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callLLM, streamLLM } from '@/lib/ai/llm';
import { attachModelFallback } from '@/lib/ai/model-fallbacks';
import { createLogger } from '@/lib/logger';
import {
  configureGenerationRunHooks,
  resetGenerationRunHooksForTests,
} from '@/lib/server/generation-run-hooks/registry';
import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { withRouteRetry } from '@/lib/server/generation/run/retry';
import { generateOutlines } from '@/lib/server/generation/steps/outline';
import { generateSceneContent } from '@/lib/server/generation/steps/scene-content';
import { generateSceneActions } from '@/lib/server/generation/steps/scene-actions';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';
import type { SceneOutline } from '@/lib/types/generation';

// Only transport and usage persistence are replaced; the SDK and generation steps are real.
vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => undefined) }));

const quota = 'insufficient_quota';
function refusal(code: string | undefined = quota, status = 429) {
  return Response.json(
    { error: { message: 'Provider refused', type: code, code } },
    {
      status,
      headers: { 'retry-after-ms': '1' },
    },
  );
}
function success(text = 'ok', stream = false) {
  const choice = { index: 0, finish_reason: 'stop' };
  return stream
    ? new Response(
        `data: ${JSON.stringify({ id: 'test', created: 0, model: 'test', choices: [{ ...choice, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    : Response.json({
        id: 'test',
        created: 0,
        model: 'test',
        choices: [{ ...choice, message: { role: 'assistant', content: text } }],
      });
}
function provider(answer: () => Response, responses = false) {
  const fetch = vi.fn(async () => answer());
  const api = createOpenAI({
    apiKey: 'test',
    baseURL: 'https://provider.example.test/v1',
    fetch,
  });
  return { model: responses ? api.responses('test') : api.chat('test'), fetch };
}
const resolved = (model: LanguageModel, serverManaged = false) => ({
  model,
  modelInfo: null,
  modelString: 'openai:test',
  thinkingConfig: undefined,
  serverManaged,
});
const context = {
  log: createLogger('QuotaRetryTest'),
  workspaceId: null,
  resolveVisionImages: async () => [],
};
const outline: SceneOutline = {
  id: 'o1',
  order: 1,
  type: 'slide',
  title: 'Leaves',
  description: 'How leaves work',
  keyPoints: ['stomata'],
};

async function streamed(model: ReturnType<typeof provider>['model'], enabled = true) {
  let text = '';
  for await (const part of streamLLM({ model, prompt: 'hello' }, 'quota-test', undefined, {
    enabled,
  }).fullStream) {
    if (part.type === 'error') throw part.error;
    if (part.type === 'text-delta') text += part.text;
  }
  return text;
}

describe('explicit provider quota stops retries', () => {
  afterEach(() => resetGenerationRunHooksForTests());

  it.each([
    quota,
    'credit_balance_exhausted',
    'organization_usage_limit_exceeded',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
  ])('stops SDK and callLLM retries on %s', async (code) => {
    const primary = provider(() => refusal(code));
    const failure = await callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test', {
      retries: 2,
    }).catch((error: unknown) => error);
    expect(runFailureCode(failure)).toEqual({
      errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      statusCode: 429,
    });
    expect(primary.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['generate', 'stream'] as const)(
    'keeps SDK retries for a bare 429 (%s)',
    async (mode) => {
      const primary = provider(() => refusal(''));
      await expect(
        mode === 'generate'
          ? callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test')
          : streamed(primary.model),
      ).rejects.toThrow();
      expect(primary.fetch).toHaveBeenCalledTimes(3);
    },
  );

  it('gates a model selected by prepareStep', async () => {
    const unused = provider(() => success());
    const primary = provider(() => refusal());
    await expect(
      callLLM(
        { model: unused.model, prompt: 'hello', prepareStep: () => ({ model: primary.model }) },
        'quota-test',
      ),
    ).rejects.toThrow();
    expect(primary.fetch).toHaveBeenCalledTimes(1);
    expect(unused.fetch).not.toHaveBeenCalled();
  });

  // An explicit quota refusal falls back whatever its status, a 403 included.
  it.each([
    ['generate', 429],
    ['generate', 403],
    ['stream', 429],
    ['stream', 403],
    ['outline', 429],
    ['outline', 403],
  ] as const)('allows the configured fallback immediately (%s, HTTP %s)', async (mode, status) => {
    const primary = provider(() => refusal(quota, status));
    const fallback = provider(() =>
      success(
        mode === 'outline' ? '{"outlines":[{"title":"Intro"}]}' : 'backup',
        mode !== 'generate',
      ),
    );
    attachModelFallback(primary.model, async () => ({
      model: fallback.model,
      modelString: 'openai:backup',
    }));
    if (mode === 'generate') {
      expect(
        (await callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test', { retries: 2 }))
          .text,
      ).toBe('backup');
    } else if (mode === 'stream') {
      expect(await streamed(primary.model)).toBe('backup');
    } else {
      expect(
        (
          await generateOutlines(
            {
              requirements: { requirement: 'Teach plants' },
              model: resolved(primary.model, true),
            },
            context,
          )
        ).outlines,
      ).toHaveLength(1);
    }
    expect(primary.fetch).toHaveBeenCalledTimes(1);
    expect(fallback.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['generate', 'stream', 'outline'] as const)(
    'does not retry either quota-exhausted model (%s)',
    async (mode) => {
      const primary = provider(() => refusal());
      const fallback = provider(() => refusal('credit_balance_exhausted', 403));
      attachModelFallback(primary.model, async () => ({
        model: fallback.model,
        modelString: 'openai:backup',
      }));
      const request =
        mode === 'generate'
          ? callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test', { retries: 2 })
          : mode === 'stream'
            ? streamed(primary.model)
            : generateOutlines(
                {
                  requirements: { requirement: 'Teach plants' },
                  model: resolved(primary.model, true),
                },
                context,
              );
      const failure = await request.catch((error: unknown) => error);
      expect(runFailureCode(failure)).toEqual({
        errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
        statusCode: 403,
      });
      expect(primary.fetch).toHaveBeenCalledTimes(1);
      expect(fallback.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let an earlier invalid result hide a later quota refusal', async () => {
    let calls = 0;
    const primary = provider(() => (++calls === 1 ? success('') : refusal()));
    const failure = await callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test', {
      retries: 3,
    }).catch((error: unknown) => error);
    expect(runFailureCode(failure)).toMatchObject({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
    expect(calls).toBe(2);
  });

  it('surfaces a quota refusal from the fallback after empty primary output', async () => {
    const primary = provider(() => success(''));
    const fallback = provider(() => refusal());
    attachModelFallback(primary.model, async () => ({
      model: fallback.model,
      modelString: 'openai:backup',
    }));
    const failure = await callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test').catch(
      (error: unknown) => error,
    );
    expect(runFailureCode(failure)).toMatchObject({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
    expect(primary.fetch).toHaveBeenCalledTimes(1);
    expect(fallback.fetch).toHaveBeenCalledTimes(1);
  });

  const streamErrors = [
    ['chat', false, { error: { message: 'No credit', code: quota, type: quota } }],
    [
      'responses error',
      true,
      { type: 'error', sequence_number: 0, message: 'No credit', code: quota, param: null },
    ],
    [
      'responses failed',
      true,
      {
        type: 'response.failed',
        sequence_number: 0,
        response: { error: { message: 'No credit', code: quota } },
      },
    ],
  ] as const;
  it.each(streamErrors)(
    'handles a quota refusal sent inside a %s stream',
    async (_label, responses, frame) => {
      for (const fallbackEnabled of [false, true]) {
        const primary = provider(
          () =>
            new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
              headers: { 'content-type': 'text/event-stream', 'retry-after-ms': '1' },
            }),
          responses,
        );
        const fallback = provider(() => success('backup', true));
        attachModelFallback(primary.model, async () => ({
          model: fallback.model,
          modelString: 'openai:backup',
        }));
        if (fallbackEnabled) {
          expect(await streamed(primary.model)).toBe('backup');
        } else {
          const failure = await streamed(primary.model, false).catch((error: unknown) => error);
          expect(runFailureCode(failure)).toMatchObject({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
        }
        expect(primary.fetch).toHaveBeenCalledTimes(1);
        expect(fallback.fetch).toHaveBeenCalledTimes(fallbackEnabled ? 1 : 0);
      }
    },
  );

  it.each(['generate', 'stream', 'outline'] as const)(
    'respects fallback opt-out (%s)',
    async (mode) => {
      const primary = provider(() => refusal());
      const fallback = provider(() => success());
      attachModelFallback(primary.model, async () => ({
        model: fallback.model,
        modelString: 'openai:backup',
      }));
      const request =
        mode === 'generate'
          ? callLLM({ model: primary.model, prompt: 'hello' }, 'verify-model', { retries: 2 })
          : mode === 'stream'
            ? streamed(primary.model, false)
            : generateOutlines(
                { requirements: { requirement: 'Teach plants' }, model: resolved(primary.model) },
                context,
              );
      await expect(request).rejects.toThrow();
      expect(primary.fetch).toHaveBeenCalledTimes(1);
      expect(fallback.fetch).not.toHaveBeenCalled();
    },
  );

  it('still gives a non-retryable host refusal precedence over fallback', async () => {
    configureGenerationRunHooks({
      name: 'test',
      classifyFailure: () => ({ errorCode: 'HOST_REFUSED', retryable: false }),
    });
    const primary = provider(() => refusal());
    const fallback = provider(() => success());
    attachModelFallback(primary.model, async () => ({
      model: fallback.model,
      modelString: 'openai:backup',
    }));
    await expect(
      callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test'),
    ).rejects.toThrow();
    expect(primary.fetch).toHaveBeenCalledTimes(1);
    expect(fallback.fetch).not.toHaveBeenCalled();
  });

  it('leaves a quota refusal the host classifies as retryable to its retries', async () => {
    // A host that rotates provider keys, say: the failure is its own to decide.
    configureGenerationRunHooks({
      name: 'test',
      classifyFailure: (error) =>
        APICallError.isInstance(error) ? { errorCode: 'KEY_ROTATED', retryable: true } : undefined,
    });
    const primary = provider(() => refusal());
    await expect(
      callLLM({ model: primary.model, prompt: 'hello' }, 'quota-test'),
    ).rejects.toThrow();
    // The SDK's own retries, as for any retryable failure.
    expect(primary.fetch).toHaveBeenCalledTimes(3);

    const scene = provider(() => refusal());
    const sleep = vi.fn(async () => {});
    await expect(
      withRouteRetry(
        () => generateSceneContent({ outline, model: resolved(scene.model) }, context),
        { label: 'content', maxRetries: 2, refusalStatus: 500, sleep },
      ),
    ).rejects.toThrow();
    expect(scene.fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('allows fallback for a native provider quota marker', async () => {
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new ProviderQuotaExhaustedError('Example', 'No credit');
      },
    });
    const fallback = provider(() => success('backup'));
    attachModelFallback(primary, async () => ({
      model: fallback.model,
      modelString: 'openai:backup',
    }));
    expect(
      (await callLLM({ model: primary, prompt: 'hello' }, 'quota-test', { retries: 2 })).text,
    ).toBe('backup');
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(fallback.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['content', 'actions'] as const)(
    'only retries transient failures through the real scene %s step',
    async (step) => {
      for (const [code, attempts] of [
        [quota, 1],
        ['rate_limit_exceeded', 3],
      ] as const) {
        const primary = provider(() => refusal(code));
        const sleep = vi.fn(async () => {});
        const onRetry = vi.fn();
        const operation = async () =>
          step === 'content'
            ? generateSceneContent({ outline, model: resolved(primary.model) }, context)
            : generateSceneActions(
                {
                  outline,
                  allOutlines: [outline],
                  content: { elements: [] },
                  stageId: 's1',
                  model: resolved(primary.model),
                },
                context,
              );
        const failure = await withRouteRetry(operation, {
          label: step,
          maxRetries: 2,
          refusalStatus: 500,
          sleep,
          onRetry,
        }).catch((error: unknown) => error);
        expect(runFailureCode(failure)).toMatchObject({
          errorCode: code === quota ? 'PROVIDER_QUOTA_EXHAUSTED' : 'RATE_LIMITED',
        });
        expect(primary.fetch).toHaveBeenCalledTimes(attempts);
        expect(sleep).toHaveBeenCalledTimes(attempts - 1);
        expect(onRetry).toHaveBeenCalledTimes(attempts - 1);
      }
    },
  );
});
