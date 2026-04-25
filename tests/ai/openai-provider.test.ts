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
});
