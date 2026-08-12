import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  responses: vi.fn((modelId: string) => ({ endpoint: 'responses', modelId })),
  createOpenAI: vi.fn(),
}));

const azureMock = vi.hoisted(() => ({
  model: vi.fn((deploymentId: string) => ({ endpoint: 'azure-responses', deploymentId })),
  createAzure: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

vi.mock('@ai-sdk/azure', () => ({
  createAzure: azureMock.createAzure,
}));

import { getModel, getModelInfo, getProvider } from '@/lib/ai/providers';
import { normalizeAzureBaseUrl } from '@/lib/ai/azure';
import type { ProviderId } from '@/lib/types/provider';

async function captureInjectedRequestBody(
  providerId: ProviderId,
  modelId: string,
  thinkingConfig?: Record<string, unknown>,
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
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'false');
    openAiMock.chat.mockClear();
    openAiMock.responses.mockClear();
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: openAiMock.responses,
    });
    azureMock.model.mockClear();
    azureMock.createAzure.mockReset();
    azureMock.createAzure.mockReturnValue(azureMock.model);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['gpt-5.6', 'GPT-5.6 Sol'],
    ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ])('includes %s as a built-in OpenAI model', (modelId, name) => {
    expect(getModelInfo('openai', modelId)).toMatchObject({
      id: modelId,
      name,
      contextWindow: 1050000,
      outputWindow: 128000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
        thinking: {
          control: 'effort',
          requestAdapter: 'openai',
          effortValues: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'medium',
          toggleable: true,
          budgetAdjustable: true,
          defaultEnabled: true,
        },
      },
    });
  });

  it.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'routes %s through the OpenAI Responses API',
    (modelId) => {
      const { model, modelInfo } = getModel({
        providerId: 'openai',
        modelId,
        apiKey: 'sk-test',
      });

      expect(openAiMock.responses).toHaveBeenCalledWith(modelId);
      expect(openAiMock.chat).not.toHaveBeenCalled();
      expect(model).toEqual({ endpoint: 'responses', modelId });
      expect(modelInfo).toBe(getModelInfo('openai', modelId));
    },
  );

  it('resolves GPT-5.6 Sol model info through the canonical built-in entry', () => {
    expect(getModelInfo('openai', 'gpt-5.6-sol')).toBe(getModelInfo('openai', 'gpt-5.6'));
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

  it('keeps the Responses API for a custom OpenAI base URL by default', () => {
    getModel({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example/v1',
    });

    const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as
      | { fetch?: typeof fetch }
      | undefined;
    expect(options?.fetch).toBeUndefined();
    expect(openAiMock.responses).toHaveBeenCalledWith('gpt-5.6-sol');
    expect(openAiMock.chat).not.toHaveBeenCalled();
  });

  it('routes a custom OpenAI base URL through Chat Completions when compatibility is enabled', () => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');

    getModel({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example/v1',
    });

    const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as
      | { fetch?: typeof fetch }
      | undefined;
    expect(options?.fetch).toBeTypeOf('function');
    expect(openAiMock.chat).toHaveBeenCalledWith('gpt-5.6-sol');
    expect(openAiMock.responses).not.toHaveBeenCalled();
  });

  it.each([
    'https://api.openai.com/v1/',
    ' https://API.openai.com/v1 ',
    'https://api.openai.com/v1?api-version=latest',
  ])('does not enable compatibility for the official OpenAI base URL: %s', (baseUrl) => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');

    getModel({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      apiKey: 'sk-test',
      baseUrl,
    });

    const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as
      | { fetch?: typeof fetch }
      | undefined;
    expect(options?.fetch).toBeUndefined();
    expect(openAiMock.responses).toHaveBeenCalledWith('gpt-5.6-sol');
    expect(openAiMock.chat).not.toHaveBeenCalled();
  });

  it('buffers custom OpenAI Chat streams for non-streaming SDK calls', async () => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    const originalFetch = globalThis.fetch;
    const chunks = [
      {
        id: 'chatcmpl_test',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-5.6-sol',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '{"elements":',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_test',
                  type: 'function',
                  function: { name: 'buildSlide', arguments: '{"title":' },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl_test',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-5.6-sol',
        choices: [
          {
            index: 0,
            delta: {
              content: '[]}',
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'buildSlide', arguments: '"Demo"}' },
                },
              ],
            },
            finish_reason: 'stop',
          },
          {
            index: 1,
            delta: { content: 'ignored secondary choice' },
            finish_reason: 'length',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        // Some relays send SSE data with this incorrect content type.
        headers: { 'content-type': 'application/json', 'content-length': '1' },
      });
    });

    try {
      globalThis.fetch = fetchMock as typeof fetch;
      getModel({
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        apiKey: 'sk-test',
        baseUrl: 'https://relay.example/v1',
      });

      const lastCall = openAiMock.createOpenAI.mock.calls.at(-1);
      const options = lastCall?.[0] as { fetch?: typeof fetch } | undefined;
      const response = await options?.fetch?.('https://relay.example/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [],
          stream: false,
          stream_options: { include_usage: false, relay_option: 'preserve' },
        }),
      });
      const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      const body = await response?.json();

      expect(request).toMatchObject({
        stream: true,
        stream_options: { include_usage: true, relay_option: 'preserve' },
      });
      expect(body.choices[0]).toMatchObject({
        message: {
          role: 'assistant',
          content: '{"elements":[]}',
          tool_calls: [
            {
              id: 'call_test',
              type: 'function',
              function: { name: 'buildSlide', arguments: '{"title":"Demo"}' },
            },
          ],
        },
        finish_reason: 'stop',
      });
      expect(body.usage.total_tokens).toBe(12);
      expect(response?.headers.get('content-type')).toBe('application/json');
      expect(response?.headers.get('content-length')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('buffers SSE after preamble fields and preserves a missing finish reason', async () => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    const originalFetch = globalThis.fetch;
    const chunk = {
      id: 'chatcmpl_preamble',
      object: 'chat.completion.chunk',
      created: 123,
      model: 'gpt-5.6-sol',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
    };
    const fetchMock = vi.fn(async () => {
      const body = `: ping\n\nevent: message\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      globalThis.fetch = fetchMock as typeof fetch;
      getModel({
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        apiKey: 'sk-test',
        baseUrl: 'https://relay.example/v1',
      });

      const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as
        | { fetch?: typeof fetch }
        | undefined;
      const response = await options?.fetch?.('https://relay.example/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [], stream: false }),
      });
      const body = await response?.json();

      expect(body.choices[0]).toMatchObject({
        message: { role: 'assistant', content: 'ok' },
        finish_reason: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates an Azure OpenAI model using the deployment name', () => {
    const { model } = getModel({
      providerId: 'azure',
      modelId: 'course-generation',
      apiKey: 'azure-key',
      baseUrl: 'https://test-resource.openai.azure.com/openai',
    });

    expect(getProvider('azure')).toMatchObject({
      type: 'azure',
      supportsModelDiscovery: false,
    });
    expect(azureMock.createAzure).toHaveBeenCalledWith({
      apiKey: 'azure-key',
      baseURL: 'https://test-resource.openai.azure.com/openai',
    });
    expect(azureMock.model).toHaveBeenCalledWith('course-generation');
    expect(model).toEqual({
      endpoint: 'azure-responses',
      deploymentId: 'course-generation',
    });
  });

  it('normalizes full Azure inference endpoints before creating the provider', () => {
    getModel({
      providerId: 'azure',
      modelId: 'course-generation',
      apiKey: 'azure-key',
      baseUrl: 'https://fast-ai-resource.services.ai.azure.com/openai/v1/chat/completions',
    });

    expect(azureMock.createAzure).toHaveBeenCalledWith({
      apiKey: 'azure-key',
      baseURL: 'https://fast-ai-resource.services.ai.azure.com/openai/v1',
    });
  });

  it('normalizes classic Azure OpenAI resource endpoints', () => {
    expect(normalizeAzureBaseUrl('https://example.openai.azure.com')).toBe(
      'https://example.openai.azure.com/openai',
    );
    expect(
      normalizeAzureBaseUrl(
        'https://example.openai.azure.com/openai/v1/chat/completions?api-version=v1',
      ),
    ).toBe('https://example.openai.azure.com/openai');
    expect(
      normalizeAzureBaseUrl(
        'https://example.openai.azure.com/openai/deployments/course-generation/chat/completions?api-version=2024-10-21',
      ),
    ).toBe('https://example.openai.azure.com/openai');
  });

  it('includes latest official GLM and Kimi models', () => {
    expect(getModelInfo('glm', 'glm-5.2')).toMatchObject({
      id: 'glm-5.2',
      name: 'GLM-5.2',
      contextWindow: 1000000,
      outputWindow: 128000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: false,
      },
    });
    expect(getModelInfo('kimi', 'kimi-k2.7-code')).toMatchObject({
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      contextWindow: 256000,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
    expect(getModelInfo('kimi', 'kimi-k2.7-code-highspeed')).toMatchObject({
      id: 'kimi-k2.7-code-highspeed',
      name: 'Kimi K2.7 Code HighSpeed',
      contextWindow: 256000,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
    expect(getModelInfo('kimi', 'kimi-k3')).toMatchObject({
      id: 'kimi-k3',
      name: 'Kimi K3',
      contextWindow: 1048576,
      outputWindow: 131072,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
  });

  it('includes latest official Doubao Seed chat models', () => {
    expect(getModelInfo('doubao', 'doubao-seed-2-1-pro-260628')).toMatchObject({
      id: 'doubao-seed-2-1-pro-260628',
      name: 'Doubao Seed 2.1 Pro',
      contextWindow: 256000,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
    expect(getModelInfo('doubao', 'doubao-seed-2-1-turbo-260628')).toMatchObject({
      id: 'doubao-seed-2-1-turbo-260628',
      name: 'Doubao Seed 2.1 Turbo',
      contextWindow: 256000,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
    expect(getModelInfo('doubao', 'doubao-seed-evolving')).toMatchObject({
      id: 'doubao-seed-evolving',
      name: 'Doubao Seed Evolving',
      contextWindow: 256000,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
    expect(getModelInfo('doubao', 'doubao-seed-character-260628')).toMatchObject({
      id: 'doubao-seed-character-260628',
      name: 'Doubao Seed Character',
      contextWindow: 256000,
      outputWindow: 32768,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
  });

  it('includes latest official Grok models with explicit output limits', () => {
    expect(getModelInfo('grok', 'grok-4.5')).toMatchObject({
      id: 'grok-4.5',
      contextWindow: 500000,
      outputWindow: 500000,
    });
    expect(getModelInfo('grok', 'grok-4.3')).toMatchObject({
      id: 'grok-4.3',
      contextWindow: 1000000,
      outputWindow: 30000,
    });
    expect(getModelInfo('grok', 'grok-build-0.1')).toMatchObject({
      id: 'grok-build-0.1',
      contextWindow: 256000,
      outputWindow: 256000,
    });
  });

  it.each([
    ['kimi', 'kimi-k3', { mode: 'enabled', effort: 'high' }, { reasoning_effort: 'high' }],
    ['grok', 'grok-4.5', { mode: 'enabled', effort: 'medium' }, { reasoning_effort: 'medium' }],
    ['grok', 'grok-4.3', { mode: 'disabled', effort: 'none' }, { reasoning_effort: 'none' }],
    ['kimi', 'kimi-k2.6', { mode: 'disabled' }, { thinking: { type: 'disabled' } }],
    ['glm', 'glm-5.1', { mode: 'enabled' }, { thinking: { type: 'enabled' } }],
    [
      'glm',
      'glm-5.2',
      { mode: 'enabled', effort: 'minimal' },
      { thinking: { type: 'enabled' }, reasoning_effort: 'minimal' },
    ],
    [
      'glm',
      'glm-5.2',
      { mode: 'enabled', effort: 'xhigh' },
      { thinking: { type: 'enabled' }, reasoning_effort: 'xhigh' },
    ],
    ['glm', 'glm-5.2', { mode: 'disabled' }, { thinking: { type: 'disabled' } }],
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
      'doubao',
      'doubao-seed-2-1-pro-260628',
      { mode: 'enabled', effort: 'high' },
      { reasoning_effort: 'high' },
    ],
    [
      'doubao',
      'doubao-seed-evolving',
      { mode: 'enabled', effort: 'medium' },
      { reasoning_effort: 'medium' },
    ],
    [
      'doubao',
      'doubao-seed-character-260628',
      { mode: 'disabled' },
      { thinking: { type: 'disabled' } },
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
    [
      'lemonade',
      'Gemma-4-26B-A4B-it-GGUF',
      { mode: 'enabled', budgetTokens: 4096 },
      { chat_template_kwargs: { enable_thinking: true, thinking_budget: 4096 } },
    ],
  ] as const)(
    'injects %s thinking params into the OpenAI-compatible request body',
    async (providerId, modelId, thinkingConfig, expected) => {
      const body = await captureInjectedRequestBody(providerId, modelId, thinkingConfig);
      expect(body).toMatchObject(expected);
    },
  );

  it('omits a zero SiliconFlow thinking budget when thinking is disabled', async () => {
    const body = await captureInjectedRequestBody('siliconflow', 'deepseek-ai/DeepSeek-V3.2', {
      mode: 'disabled',
    });

    expect(body).toMatchObject({ enable_thinking: false });
    expect(body).not.toHaveProperty('thinking_budget');
  });

  it('disables Lemonade thinking by default for recognized local reasoning models', async () => {
    const body = await captureInjectedRequestBody('lemonade', 'Gemma-4-26B-A4B-it-GGUF');

    expect(body).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('recognizes manually added Lemonade reasoning model IDs', async () => {
    const body = await captureInjectedRequestBody('lemonade', 'custom-gpt-oss-20b-q4');

    expect(body).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('disables Lemonade thinking by default for non-catalog local models too', async () => {
    const body = await captureInjectedRequestBody('lemonade', 'Gemma-4-26B-A4B-it-GGUF');

    expect(body).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('strips unsupported Lemonade stream_options while preserving thinking overrides', async () => {
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
        getStore: () => ({ mode: 'disabled' }),
      };

      getModel({
        providerId: 'lemonade',
        modelId: 'Gemma-4-26B-A4B-it-GGUF',
        apiKey: '',
      });

      const lastCall = openAiMock.createOpenAI.mock.calls.at(-1);
      const options = lastCall?.[0] as { fetch?: typeof fetch } | undefined;

      await options?.fetch?.('https://example.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'Gemma-4-26B-A4B-it-GGUF',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(init.body as string);

      expect(body.stream_options).toBeUndefined();
      expect(body).toMatchObject({
        chat_template_kwargs: { enable_thinking: false },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalThinkingContext === undefined) {
        delete globalRecord.__thinkingContext;
      } else {
        globalRecord.__thinkingContext = originalThinkingContext;
      }
    }
  });
});
