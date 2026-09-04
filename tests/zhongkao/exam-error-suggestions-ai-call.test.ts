import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelMocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: modelMocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: modelMocks.resolveModel }));

import { createExamErrorSuggestionAiCall } from '@/lib/server/zhongkao/exam-error-suggestions-ai-call';

describe('Exam error suggestion AI call provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lazily binds the actual routed model once and exposes only bounded identity metadata', async () => {
    const abortController = new AbortController();
    const model = { fixture: 'same-model-object' };
    const thinkingConfig = { mode: 'enabled' };
    modelMocks.resolveModel.mockResolvedValue({
      model,
      modelInfo: { outputWindow: 2_048 },
      modelString: 'fixture-provider:fixture-model',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      apiKey: 'PRIVATE_API_KEY_CANARY',
      baseUrl: 'https://private.invalid',
      thinkingConfig,
    });
    modelMocks.callLLM.mockResolvedValue({ text: '{"schemaVersion":1,"results":[]}' });

    const binding = createExamErrorSuggestionAiCall({
      abortSignal: abortController.signal,
      maxOutputTokens: 16_384,
    });

    expect(binding.getModelExecution()).toBeUndefined();
    expect(modelMocks.resolveModel).not.toHaveBeenCalled();

    await expect(binding.call('system', 'user')).resolves.toBe('{"schemaVersion":1,"results":[]}');
    await expect(binding.call('system-2', 'user-2')).resolves.toBe(
      '{"schemaVersion":1,"results":[]}',
    );

    expect(modelMocks.resolveModel).toHaveBeenCalledExactlyOnceWith({
      stage: 'exam-error-suggestions',
    });
    expect(modelMocks.callLLM).toHaveBeenCalledTimes(2);
    expect(modelMocks.callLLM).toHaveBeenNthCalledWith(
      1,
      {
        model,
        system: 'system',
        prompt: 'user',
        maxOutputTokens: 2_048,
        maxRetries: 0,
        abortSignal: abortController.signal,
      },
      'exam-error-suggestions',
      undefined,
      thinkingConfig,
    );
    const metadata = binding.getModelExecution();
    expect(metadata).toEqual({
      status: 'used',
      stage: 'exam-error-suggestions',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
    });
    expect(JSON.stringify(metadata)).not.toMatch(/API_KEY|baseUrl|modelString|private\.invalid/u);
  });

  it('keeps configured output limits when the resolved model has no smaller valid window', async () => {
    modelMocks.resolveModel.mockResolvedValue({
      model: { fixture: 'model' },
      modelInfo: null,
      modelString: 'fixture-provider:fixture-model',
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      apiKey: '',
    });
    modelMocks.callLLM.mockResolvedValue({ text: 'ok' });
    const binding = createExamErrorSuggestionAiCall({ maxOutputTokens: 16_384 });

    await binding.call('system', 'user');

    expect(modelMocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 16_384 }),
      'exam-error-suggestions',
      undefined,
      undefined,
    );
  });

  it('rejects invalid output-token limits before resolving a model', () => {
    expect(() => createExamErrorSuggestionAiCall({ maxOutputTokens: 0 })).toThrow(RangeError);
    expect(modelMocks.resolveModel).not.toHaveBeenCalled();
  });
});
