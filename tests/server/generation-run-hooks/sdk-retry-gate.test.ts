/**
 * The AI SDK retries a retryable provider answer (a 429, a 5xx) itself,
 * before any step sees it. A host whose own gateway answers such a status for
 * a failure no retry helps (a used-up quota) classifies it, and the real
 * SDK retry layer then stops at the first request. The provider is real; only
 * its HTTP transport is replaced.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callLLM, streamLLM } from '@/lib/ai/llm';
import { attachModelFallback } from '@/lib/ai/model-fallbacks';
import { createLogger } from '@/lib/logger';
import {
  configureGenerationRunHooks,
  resetGenerationRunHooksForTests,
} from '@/lib/server/generation-run-hooks/registry';
import { classifyHostFailure } from '@/lib/server/generation-run-hooks/runtime';
import { generateOutlines } from '@/lib/server/generation/steps/outline';

const requests = vi.fn();

/** Every request is refused by the host's gateway with a retryable status. */
async function hostGateway(): Promise<Response> {
  requests();
  return new Response(
    JSON.stringify({ error: { message: 'Quota used up', type: 'host_quota_exhausted' } }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } },
  );
}

const model = () =>
  createOpenAI({
    apiKey: 'test-key',
    baseURL: 'https://llm.example.test/v1',
    fetch: hostGateway as typeof fetch,
  }).chat('gpt-4o-mini');

function registerClassifier() {
  configureGenerationRunHooks({
    name: 'host',
    classifyFailure: (error) =>
      APICallError.isInstance(error) && error.responseBody?.includes('host_quota_exhausted')
        ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false }
        : undefined,
  });
}

async function streamed(): Promise<unknown> {
  const result = streamLLM({ model: model(), prompt: 'Hello' }, 'sdk-retry-gate', undefined, {
    enabled: false,
  });
  for await (const part of result.fullStream) {
    if (part.type === 'error') return part.error;
  }
  return undefined;
}

describe('the SDK retry layer and a host failure', () => {
  beforeEach(() => {
    resetGenerationRunHooksForTests();
    requests.mockReset();
  });
  afterEach(() => resetGenerationRunHooksForTests());

  it('is retried by the SDK as before without a classifier', async () => {
    expect(await streamed()).toBeDefined();
    expect(requests).toHaveBeenCalledTimes(3);
    requests.mockReset();
    await expect(callLLM({ model: model(), prompt: 'Hello' }, 'sdk-retry-gate')).rejects.toThrow();
    expect(requests).toHaveBeenCalledTimes(3);
  });

  it('stops at the first request when the host says no retry helps', async () => {
    registerClassifier();
    const error = await streamed();
    expect(requests).toHaveBeenCalledTimes(1);
    expect(classifyHostFailure(error)).toEqual({ errorCode: 'QUOTA_EXHAUSTED', retryable: false });

    requests.mockReset();
    const thrown = await callLLM({ model: model(), prompt: 'Hello' }, 'sdk-retry-gate').catch(
      (caught: unknown) => caught,
    );
    expect(requests).toHaveBeenCalledTimes(1);
    expect(classifyHostFailure(thrown)).toMatchObject({ errorCode: 'QUOTA_EXHAUSTED' });
  });

  it('fails the outline step after one request, with the host failure', async () => {
    const outline = () =>
      generateOutlines(
        {
          requirements: { requirement: 'Teach photosynthesis' },
          model: {
            model: model(),
            modelInfo: { capabilities: {} },
            modelString: 'openai:gpt-4o-mini',
            thinkingConfig: undefined,
            serverManaged: false,
          } as never,
        },
        {
          log: createLogger('Outline'),
          workspaceId: null,
          resolveVisionImages: async (images) => [...images],
          emit: () => undefined,
        },
      ).catch((error: unknown) => error);

    // Without a classifier: the step's three attempts, each retried by the SDK.
    await outline();
    expect(requests).toHaveBeenCalledTimes(9);

    requests.mockReset();
    resetGenerationRunHooksForTests();
    registerClassifier();
    expect(classifyHostFailure(await outline())).toMatchObject({ errorCode: 'QUOTA_EXHAUSTED' });
    expect(requests).toHaveBeenCalledTimes(1);
  });

  /** The same provider, presented as a v2 model (the SDK still accepts those). */
  const v2Model = () => {
    const v3 = model();
    return {
      specificationVersion: 'v2' as const,
      provider: v3.provider,
      modelId: v3.modelId,
      supportedUrls: {},
      doGenerate: (options: unknown) => v3.doGenerate(options as never),
      doStream: (options: unknown) => v3.doStream(options as never),
    };
  };

  /** A model that must never be called: `prepareStep` swaps it out. */
  const unused = vi.fn();
  const replacedModel = () =>
    createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://other.example.test/v1',
      fetch: (async () => {
        unused();
        throw new Error('the replaced model was called');
      }) as typeof fetch,
    }).chat('gpt-4o-mini');

  const cases: Array<[string, () => Promise<unknown>, number]> = [
    [
      'a v2 model, streamed',
      async () => {
        const result = streamLLM(
          { model: v2Model() as never, prompt: 'Hello' },
          'gate',
          undefined,
          {
            enabled: false,
          },
        );
        for await (const part of result.fullStream) if (part.type === 'error') break;
      },
      3,
    ],
    [
      'a v2 model, generated',
      () => callLLM({ model: v2Model() as never, prompt: 'Hello' }, 'gate').catch(() => undefined),
      3,
    ],
    [
      'the model prepareStep picks for a step, generated',
      () =>
        callLLM(
          {
            model: replacedModel(),
            prompt: 'Hello',
            prepareStep: async () => ({ model: model() }),
          },
          'gate',
        ).catch(() => undefined),
      3,
    ],
    [
      'the model prepareStep picks for a step, streamed',
      async () => {
        const result = streamLLM(
          {
            model: replacedModel(),
            prompt: 'Hello',
            prepareStep: async () => ({ model: model() }),
          },
          'gate',
          undefined,
          { enabled: false },
        );
        for await (const part of result.fullStream) if (part.type === 'error') break;
      },
      3,
    ],
    [
      "callLLM's own retries",
      () =>
        callLLM({ model: model(), prompt: 'Hello' }, 'gate', { retries: 1 }).catch(() => undefined),
      6,
    ],
  ];

  it.each(cases)('gates %s: one request with the classifier', async (_label, call, without) => {
    unused.mockReset();
    await call();
    expect(requests).toHaveBeenCalledTimes(without);
    requests.mockReset();
    resetGenerationRunHooksForTests();
    registerClassifier();
    await call();
    expect(requests).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });

  it('gates a frozen model: it works, and stops at one request', async () => {
    const live = model();
    const frozen = Object.freeze({
      specificationVersion: 'v3' as const,
      provider: live.provider,
      modelId: live.modelId,
      supportedUrls: live.supportedUrls,
      doGenerate: live.doGenerate.bind(live),
      doStream: live.doStream.bind(live),
    });
    registerClassifier();
    const thrown = await callLLM({ model: frozen, prompt: 'Hello' }, 'gate').catch(
      (caught: unknown) => caught,
    );
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(classifyHostFailure(thrown)).toMatchObject({ errorCode: 'QUOTA_EXHAUSTED' });
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("throws the host failure, not an earlier attempt's invalid result", async () => {
    // Attempt 1 answers text the caller's validator refuses; attempt 2 meets
    // the host's refusal.
    let calls = 0;
    const sequence = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://llm.example.test/v1',
      fetch: (async () => {
        calls += 1;
        if (calls > 1) return hostGateway();
        return new Response(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'invalid' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    }).chat('gpt-4o-mini');
    registerClassifier();
    const outcome = await callLLM({ model: sequence, prompt: 'Hello' }, 'gate', {
      retries: 1,
      validate: (text) => text === 'valid',
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    expect(calls).toBe(2);
    expect('error' in outcome && classifyHostFailure(outcome.error)).toMatchObject({
      errorCode: 'QUOTA_EXHAUSTED',
    });
  });
  it("throws the fallback's host failure, not the primary's empty result", async () => {
    // The primary answers empty text, which arms the slot fallback; the
    // fallback meets the host's refusal.
    const empty = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://primary.example.test/v1',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o-mini',
            choices: [
              { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    }).chat('gpt-4o-mini');
    attachModelFallback(empty, async () => ({
      model: model(),
      modelString: 'openai:fallback',
    }));
    registerClassifier();
    const outcome = await callLLM({ model: empty, prompt: 'Hello' }, 'gate').then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    expect(requests).toHaveBeenCalledTimes(1);
    expect('error' in outcome && classifyHostFailure(outcome.error)).toMatchObject({
      errorCode: 'QUOTA_EXHAUSTED',
    });
  });
});
