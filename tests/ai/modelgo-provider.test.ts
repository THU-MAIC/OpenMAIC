import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: openAiMock.createOpenAI }));
vi.mock('@ai-sdk/azure', () => ({ createAzure: vi.fn() }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: vi.fn() }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: vi.fn() }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    wrapLanguageModel: vi.fn(({ model }) => model),
    extractReasoningMiddleware: vi.fn(() => ({})),
  };
});

import { getModel, getProvider } from '@/lib/ai/providers';

describe('ModelGo provider', () => {
  beforeEach(() => {
    openAiMock.chat.mockClear();
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: vi.fn(),
    });
  });

  it('registers ModelGo as a discovery-backed OpenAI-compatible provider', () => {
    expect(getProvider('modelgo')).toMatchObject({
      id: 'modelgo',
      name: 'ModelGo',
      type: 'openai',
      defaultBaseUrl: 'https://api.modelgo.ai/v1',
      supportsModelDiscovery: true,
      requiresApiKey: true,
      models: [],
    });
  });

  it('creates discovered models with the ModelGo base URL', () => {
    const { model } = getModel({
      providerId: 'modelgo',
      modelId: 'gpt-6.1-sol',
      apiKey: 'mgk-test',
    });

    expect(openAiMock.createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'mgk-test',
        baseURL: 'https://api.modelgo.ai/v1',
      }),
    );
    expect(openAiMock.chat).toHaveBeenCalledWith('gpt-6.1-sol');
    expect(model).toEqual({ endpoint: 'chat', modelId: 'gpt-6.1-sol' });
  });
});
