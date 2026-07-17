import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

vi.mock('@ai-sdk/azure', () => ({
  createAzure: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    wrapLanguageModel: vi.fn(({ model }) => model),
    extractReasoningMiddleware: vi.fn(() => ({})),
  };
});

import { getModel, getModelInfo, getProvider } from '@/lib/ai/providers';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';

describe('Atlas Cloud provider', () => {
  beforeEach(() => {
    openAiMock.chat.mockClear();
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: vi.fn(),
    });
  });

  it('registers Atlas Cloud as an OpenAI-compatible built-in provider', () => {
    expect(getProvider('atlascloud')).toMatchObject({
      id: 'atlascloud',
      name: 'Atlas Cloud',
      type: 'openai',
      defaultBaseUrl: 'https://api.atlascloud.ai/v1',
      supportsModelDiscovery: true,
      requiresApiKey: true,
    });
  });

  it('includes live-verified Atlas Cloud model catalog entries', () => {
    expect(getModelInfo('atlascloud', 'qwen/qwen3.5-flash')).toMatchObject({
      id: 'qwen/qwen3.5-flash',
      name: 'Qwen3.5 Flash',
      contextWindow: 1000000,
      outputWindow: 67072,
    });
    expect(getModelInfo('atlascloud', 'deepseek-ai/deepseek-v4-pro')).toMatchObject({
      id: 'deepseek-ai/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1048576,
      outputWindow: 393216,
      capabilities: {
        streaming: true,
        tools: true,
        vision: false,
      },
    });
  });

  it('creates Atlas Cloud models with the Atlas Cloud base URL', () => {
    const { model } = getModel({
      providerId: 'atlascloud',
      modelId: 'qwen/qwen3.5-flash',
      apiKey: 'sk-atlas',
    });

    expect(openAiMock.createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-atlas',
        baseURL: 'https://api.atlascloud.ai/v1',
      }),
    );
    expect(openAiMock.chat).toHaveBeenCalledWith('qwen/qwen3.5-flash');
    expect(model).toEqual({ endpoint: 'chat', modelId: 'qwen/qwen3.5-flash' });
  });

  it('uses the existing DeepSeek reasoning adapter for Atlas Cloud DeepSeek models', () => {
    expect(getCatalogThinkingCapability('atlascloud', 'deepseek-ai/deepseek-v4-pro')).toMatchObject(
      {
        requestAdapter: 'deepseek',
        defaultEffort: 'high',
      },
    );
  });
});
