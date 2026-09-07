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

describe('Token Market provider', () => {
  beforeEach(() => {
    openAiMock.chat.mockClear();
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: vi.fn(),
    });
  });

  it('registers Token Market as a discoverable OpenAI-compatible provider', () => {
    expect(getProvider('tokensmarket')).toMatchObject({
      id: 'tokensmarket',
      name: 'Token Market',
      type: 'openai',
      defaultBaseUrl: 'https://api.tokensmarket.ai/v1',
      supportsModelDiscovery: true,
      requiresApiKey: true,
      icon: '/logos/tokensmarket.svg',
    });
  });

  it('includes a conservative cross-vendor chat catalog', () => {
    expect(getModelInfo('tokensmarket', 'gpt-5.6-luna')).toMatchObject({
      contextWindow: 1050000,
      outputWindow: 128000,
      capabilities: { streaming: true, tools: true, vision: true },
    });
    expect(getModelInfo('tokensmarket', 'deepseek-v4-pro')).toMatchObject({
      contextWindow: 1048576,
      outputWindow: 393216,
      capabilities: { streaming: true, tools: true, vision: false },
    });
  });

  it('creates chat models with the Token Market base URL', () => {
    const { model } = getModel({
      providerId: 'tokensmarket',
      modelId: 'gpt-5.6-luna',
      apiKey: 'sk-tokensmarket',
    });

    expect(openAiMock.createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-tokensmarket',
        baseURL: 'https://api.tokensmarket.ai/v1',
        name: 'tokensmarket',
      }),
    );
    expect(openAiMock.chat).toHaveBeenCalledWith('gpt-5.6-luna');
    expect(model).toEqual({ endpoint: 'chat', modelId: 'gpt-5.6-luna' });
  });
});
