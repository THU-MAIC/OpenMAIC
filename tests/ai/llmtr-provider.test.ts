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

import { getModel, getProvider } from '@/lib/ai/providers';
import { LLM_ENV_MAP } from '@/lib/server/provider-config';
import { getProviderPreset } from '@/lib/config/provider-presets';

describe('llmtr chat provider', () => {
  beforeEach(() => {
    openAiMock.chat.mockClear();
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: vi.fn(),
    });
  });

  it('registers an OpenAI-compatible preset at https://llmtr.com/v1', () => {
    expect(getProvider('llmtr')).toMatchObject({
      id: 'llmtr',
      name: 'LLMTR',
      type: 'openai',
      defaultBaseUrl: 'https://llmtr.com/v1',
      requiresApiKey: true,
      models: [],
    });
    expect(getProvider('llmtr')?.icon).toBeUndefined();
    expect(LLM_ENV_MAP.LLMTR).toBe('llmtr');
    expect(getProviderPreset('llmtr')?.capabilities.chat?.registryId).toBe('llmtr');
  });

  it('builds a model against the default LLMTR base URL', () => {
    const { model } = getModel({
      providerId: 'llmtr',
      modelId: 'catalog-model',
      apiKey: 'sk-test',
    });

    expect(openAiMock.createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        baseURL: 'https://llmtr.com/v1',
        name: 'llmtr',
      }),
    );
    expect(openAiMock.chat).toHaveBeenCalledWith('catalog-model');
    expect(model).toEqual({ endpoint: 'chat', modelId: 'catalog-model' });
  });

  it('requires an API key', () => {
    expect(() =>
      getModel({
        providerId: 'llmtr',
        modelId: 'catalog-model',
      }),
    ).toThrow(/API key required for provider: llmtr/);
  });
});
