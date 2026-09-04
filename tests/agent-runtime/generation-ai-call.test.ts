import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));

import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';

const STAGE = 'exam-knowledge-suggestions' as const;
const MODEL = { modelId: 'fictional-model' };
const THINKING = { mode: 'disabled' } as const;

function resolvedModel(outputWindow: number | null) {
  return {
    model: MODEL,
    modelInfo:
      outputWindow === null
        ? null
        : { id: 'fictional-model', name: 'Fictional model', outputWindow },
    thinkingConfig: THINKING,
  };
}

beforeEach(() => {
  mocks.callLLM.mockReset().mockResolvedValue({ text: '{"schemaVersion":1}' });
  mocks.resolveModel.mockReset();
});

describe('createGenerationAiCallFactory output bounds', () => {
  it.each([
    ['caps a larger catalog window', 128_000, 32_768, 32_768],
    ['keeps a smaller catalog window', 4_096, 32_768, 4_096],
    ['uses the configured cap when model metadata is missing', null, 32_768, 32_768],
  ] as const)('%s', async (_name, outputWindow, cap, expected) => {
    mocks.resolveModel.mockResolvedValueOnce(resolvedModel(outputWindow));
    const call = createGenerationAiCallFactory({ maxOutputTokens: cap })(STAGE);

    await expect(call('system prompt', 'user prompt')).resolves.toBe('{"schemaVersion":1}');

    expect(mocks.resolveModel).toHaveBeenCalledExactlyOnceWith({ stage: STAGE });
    expect(mocks.callLLM).toHaveBeenCalledExactlyOnceWith(
      {
        model: MODEL,
        system: 'system prompt',
        prompt: 'user prompt',
        maxOutputTokens: expected,
        maxRetries: 0,
        abortSignal: undefined,
      },
      STAGE,
      undefined,
      THINKING,
    );
  });

  it('preserves the catalog output window when no cap is configured', async () => {
    const abortController = new AbortController();
    mocks.resolveModel.mockResolvedValueOnce(resolvedModel(128_000));
    const call = createGenerationAiCallFactory({ abortSignal: abortController.signal })(STAGE);

    await call('system prompt', 'user prompt');

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 128_000,
        abortSignal: abortController.signal,
      }),
      STAGE,
      undefined,
      THINKING,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxOutputTokens %s before resolving a model',
    (maxOutputTokens) => {
      expect(() => createGenerationAiCallFactory({ maxOutputTokens })).toThrowError(
        new RangeError('maxOutputTokens must be a positive safe integer'),
      );
      expect(mocks.resolveModel).not.toHaveBeenCalled();
      expect(mocks.callLLM).not.toHaveBeenCalled();
    },
  );
});
