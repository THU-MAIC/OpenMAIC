import { beforeEach, describe, expect, it, vi } from 'vitest';

// The first Agent construction fails and later ones succeed, so this file can
// observe both the fallback path and the cache reset in getLlmDispatcher.
const undiciMock = vi.hoisted(() => ({ constructions: 0, options: [] as unknown[] }));

vi.mock('undici', () => ({
  Agent: class {
    constructor(options: unknown) {
      undiciMock.options.push(options);
      undiciMock.constructions += 1;
      if (undiciMock.constructions === 1) {
        throw new Error('transient undici failure');
      }
    }
  },
}));

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  responses: vi.fn((modelId: string) => ({ endpoint: 'responses', modelId })),
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

import { getModel, llmFetchTimeoutMs, LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';
import { llmExecutionContext } from '@/lib/ai/thinking-context';

describe('LLM dispatcher failure handling', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'false');
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: openAiMock.responses,
    });
  });

  it('uses an unbounded dispatcher only inside the V3 call scope', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    const { model } = getModel({
      providerId: 'openai',
      modelId: 'gpt-5.3',
      apiKey: 'test',
      fetchImpl: fetchMock,
    });
    void model;
    const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as { fetch: typeof fetch };
    // The failure-handling test below owns its first failed construction.
    undiciMock.constructions = 1;
    expect(llmFetchTimeoutMs()).toBe(LLM_FETCH_TIMEOUT_MS);
    await llmExecutionContext.run({ unbounded: true }, async () => {
      expect(llmFetchTimeoutMs()).toBe(0);
      await options.fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' });
    });
    expect(undiciMock.options.at(-1)).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
    expect(llmFetchTimeoutMs()).toBe(LLM_FETCH_TIMEOUT_MS);
    undiciMock.constructions = 0;
  });
  it('falls back to the plain transport once and recovers on the next call', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      globalThis.fetch = fetchMock as typeof fetch;

      getModel({ providerId: 'openai', modelId: 'gpt-5.3', apiKey: 'sk-test' });
      const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as {
        fetch?: typeof fetch;
      };

      // First call: the Agent constructor throws — the request must still go
      // out (without a dispatcher, riding undici's default timeout) rather
      // than failing the LLM call outright.
      await options?.fetch?.('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
      });
      let init = fetchMock.mock.calls.at(-1)?.[1] as
        | (RequestInit & { dispatcher?: unknown })
        | undefined;
      expect(init?.dispatcher).toBeUndefined();

      // Second call: the rejection was dropped from the cache, so the Agent
      // is built again — this time the request carries it.
      await options?.fetch?.('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
      });
      init = fetchMock.mock.calls.at(-1)?.[1] as
        | (RequestInit & { dispatcher?: unknown })
        | undefined;
      expect(init?.dispatcher).toBeTruthy();
      expect(undiciMock.constructions).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
