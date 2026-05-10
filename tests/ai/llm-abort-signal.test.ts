import { describe, expect, it, vi, beforeEach } from 'vitest';

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(async (params: unknown) => ({ text: 'ok', params })),
  streamText: vi.fn((params: unknown) => ({ params, textStream: (async function* () {})() })),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

import { callLLM, streamLLM } from '@/lib/ai/llm';

describe('LLM AbortSignal propagation', () => {
  beforeEach(() => {
    aiMock.generateText.mockClear();
    aiMock.streamText.mockClear();
  });

  it('callLLM forwards the supplied signal to generateText as abortSignal', async () => {
    const controller = new AbortController();
    await callLLM(
      {
        model: { provider: 'openai.chat', modelId: 'gpt-4o-mini' },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      undefined,
      controller.signal,
    );

    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    const params = aiMock.generateText.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(params.abortSignal).toBe(controller.signal);
  });

  it('callLLM omits abortSignal when no signal is supplied', async () => {
    await callLLM(
      {
        model: { provider: 'openai.chat', modelId: 'gpt-4o-mini' },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    const params = aiMock.generateText.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(params.abortSignal).toBeUndefined();
  });

  it("respects an abortSignal that the caller already placed in params (caller's wins)", async () => {
    const callerController = new AbortController();
    const overrideController = new AbortController();
    await callLLM(
      {
        model: { provider: 'openai.chat', modelId: 'gpt-4o-mini' },
        prompt: 'hi',
        abortSignal: callerController.signal,
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      undefined,
      overrideController.signal,
    );

    const params = aiMock.generateText.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    // If the caller already wired their own signal, do not silently overwrite it.
    expect(params.abortSignal).toBe(callerController.signal);
  });

  it('streamLLM forwards the supplied signal to streamText as abortSignal', () => {
    const controller = new AbortController();
    streamLLM(
      {
        model: { provider: 'openai.chat', modelId: 'gpt-4o-mini' },
        prompt: 'hi',
      } as Parameters<typeof streamLLM>[0],
      'test',
      undefined,
      controller.signal,
    );

    expect(aiMock.streamText).toHaveBeenCalledTimes(1);
    const params = aiMock.streamText.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(params.abortSignal).toBe(controller.signal);
  });
});
