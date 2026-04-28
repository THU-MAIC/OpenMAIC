import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  responses: vi.fn((modelId: string) => ({ endpoint: 'responses', modelId })),
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

import { getModel, getModelInfo } from '@/lib/ai/providers';
import type { ProviderId } from '@/lib/types/provider';

async function captureInjectedRequestBody(
  providerId: ProviderId,
  modelId: string,
  thinkingConfig: Record<string, unknown>,
) {
  const originalFetch = globalThis.fetch;
  const globalRecord = globalThis as Record<string, unknown>;
  const originalThinkingContext = globalRecord.__thinkingContext;
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    globalThis.fetch = fetchMock as typeof fetch;
    globalRecord.__thinkingContext = {
      getStore: () => thinkingConfig,
    };

    getModel({
      providerId,
      modelId,
      apiKey: 'sk-test',
    });

    const lastCall = openAiMock.createOpenAI.mock.calls.at(-1);
    const options = lastCall?.[0] as { fetch?: typeof fetch } | undefined;

    await options?.fetch?.('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(init.body as string);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalThinkingContext === undefined) {
      delete globalRecord.__thinkingContext;
    } else {
      globalRecord.__thinkingContext = originalThinkingContext;
    }
  }
}

describe('OpenAI provider defaults', () => {
  beforeEach(() => {
    openAiMock.chat.mockClear();
    openAiMock.responses.mockClear();
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: openAiMock.responses,
    });
  });

  it('includes GPT-5.5 as a built-in OpenAI model', () => {
    expect(getModelInfo('openai', 'gpt-5.5')).toMatchObject({
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 1050000,
      outputWindow: 128000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        thinking: {
          toggleable: false,
          budgetAdjustable: true,
          defaultEnabled: true,
        },
      },
    });
  });

  it('routes GPT-5.5 through the OpenAI Responses API', () => {
    const { model } = getModel({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      apiKey: 'sk-test',
    });

    expect(openAiMock.responses).toHaveBeenCalledWith('gpt-5.5');
    expect(openAiMock.chat).not.toHaveBeenCalled();
    expect(model).toEqual({ endpoint: 'responses', modelId: 'gpt-5.5' });
  });

  it.each([
    ['kimi', 'kimi-k2.6', { mode: 'disabled' }, { thinking: { type: 'disabled' } }],
    ['glm', 'glm-5.1', { mode: 'enabled' }, { thinking: { type: 'enabled' } }],
    ['xiaomi', 'mimo-v2.5', { mode: 'disabled' }, { thinking: { type: 'disabled' } }],
    [
      'deepseek',
      'deepseek-v4-pro',
      { mode: 'enabled', effort: 'max' },
      { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    ],
    [
      'qwen',
      'qwen3.6-plus',
      { mode: 'enabled', budgetTokens: 4096 },
      { enable_thinking: true, thinking_budget: 4096 },
    ],
    [
      'siliconflow',
      'deepseek-ai/DeepSeek-R1',
      { mode: 'enabled', budgetTokens: 2048 },
      { thinking_budget: 2048 },
    ],
    [
      'doubao',
      'doubao-seed-2-0-pro-260215',
      { mode: 'enabled', effort: 'high' },
      { reasoning_effort: 'high' },
    ],
    [
      'openrouter',
      'deepseek/deepseek-v4-pro',
      { mode: 'enabled', effort: 'high' },
      { reasoning: { enabled: true, effort: 'high' } },
    ],
    [
      'tencent-hunyuan',
      'hy3-preview',
      { mode: 'enabled', effort: 'high' },
      { chat_template_kwargs: { reasoning_effort: 'high' } },
    ],
  ] as const)(
    'injects %s thinking params into the OpenAI-compatible request body',
    async (providerId, modelId, thinkingConfig, expected) => {
      const body = await captureInjectedRequestBody(providerId, modelId, thinkingConfig);
      expect(body).toMatchObject(expected);
    },
  );
});
