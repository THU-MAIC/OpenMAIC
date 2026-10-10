import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';

import { createLogger } from '@/lib/logger';

const streamLLMMock = vi.fn();

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: (...args: unknown[]) => streamLLMMock(...args),
}));

const fallbackMocks = vi.hoisted(() => ({
  resolveFallbackModel: vi.fn(),
  shouldFallbackFor: vi.fn(),
  logFallbackFired: vi.fn(),
}));

vi.mock('@/lib/server/llm-fallback', () => fallbackMocks);

import { generateOutlines } from '@/lib/server/generation/steps/outline';

/**
 * Generate the outlines with `model` as a run does, and return what the step
 * reported followed by its failure (`error`), if it failed.
 */
async function outlineEvents(
  model: ReturnType<typeof resolvedModel>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  try {
    await generateOutlines(
      { requirements: { requirement: 'Teach photosynthesis' }, model: model as never },
      {
        log: createLogger('Outline'),
        workspaceId: null,
        resolveVisionImages: async (images) => [...images],
        emit: (event) => events.push(event),
      },
    );
  } catch (error) {
    events.push({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
  return events;
}

/** Wraps fullStream parts in the shape streamLLM(...).fullStream provides. */
function fullStreamOf(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
  };
}

function streamError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    statusCode,
    responseBody: '',
    isRetryable: statusCode === 429,
  });
}

const OUTLINE_TEXT = '{"languageDirective":"English","outlines":[{"title":"Intro"}]}';

function resolvedModel(serverManaged: boolean) {
  return {
    model: { provider: 'openai.responses', modelId: 'gpt-5.4' },
    modelInfo: { capabilities: {} },
    modelString: 'openai:gpt-5.4',
    thinkingConfig: undefined,
    serverManaged,
  };
}

describe('outline step fallback wiring', () => {
  beforeEach(() => {
    streamLLMMock.mockReset();
    fallbackMocks.resolveFallbackModel.mockReset();
    fallbackMocks.shouldFallbackFor.mockReset();
    fallbackMocks.logFallbackFired.mockReset();
    fallbackMocks.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model',
      modelString: 'qwen:deepseek-v4-pro',
    });
  });

  it('surfaces a pre-stream 401 error part instead of falling back', async () => {
    // streamText surfaces pre-stream API errors as an error part, not a throw;
    // with textStream alone this used to look like an empty response. Same-model
    // retries run first (existing behaviour), but a non-retryable 401 never
    // reaches the fallback.
    streamLLMMock.mockImplementation(() =>
      fullStreamOf([
        { type: 'error', error: streamError(401, 'unauthorized') },
        { type: 'finish', finishReason: 'error' },
      ]),
    );
    fallbackMocks.shouldFallbackFor.mockReturnValue(false);

    const events = await outlineEvents(resolvedModel(true));

    expect(events.some((e) => e.type === 'error' && e.error === 'unauthorized')).toBe(true);
    expect(streamLLMMock).toHaveBeenCalledTimes(3);
    expect(fallbackMocks.resolveFallbackModel).not.toHaveBeenCalled();
    expect(fallbackMocks.logFallbackFired).not.toHaveBeenCalled();
  });

  it('falls back once on a retryable stream error (server-managed primary)', async () => {
    // Same-model retries exhaust first (1 initial + MAX_STREAM_RETRIES), then
    // the fallback round runs with the fallback model and succeeds.
    streamLLMMock
      .mockImplementationOnce(() =>
        fullStreamOf([{ type: 'error', error: streamError(429, 'quota exceeded') }]),
      )
      .mockImplementationOnce(() =>
        fullStreamOf([{ type: 'error', error: streamError(429, 'quota exceeded') }]),
      )
      .mockImplementationOnce(() =>
        fullStreamOf([{ type: 'error', error: streamError(429, 'quota exceeded') }]),
      )
      .mockImplementationOnce(() =>
        fullStreamOf([
          { type: 'text-delta', text: OUTLINE_TEXT },
          { type: 'finish', finishReason: 'stop' },
        ]),
      );
    fallbackMocks.shouldFallbackFor.mockReturnValue(true);

    const events = await outlineEvents(resolvedModel(true));

    expect(streamLLMMock).toHaveBeenCalledTimes(4);
    // The last round carries the fallback model.
    const lastParams = streamLLMMock.mock.calls[3][0] as { model: unknown };
    expect(lastParams.model).toBe('fallback-model');
    expect(fallbackMocks.logFallbackFired).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'retry' && e.fallback === 'qwen:deepseek-v4-pro')).toBe(
      true,
    );
  });

  it('does not fall back when the primary is not server-managed', async () => {
    // A model the operator does not manage must never reach the fallback key,
    // even when every same-model retry fails retryably.
    streamLLMMock.mockImplementation(() =>
      fullStreamOf([{ type: 'finish', finishReason: 'stop' }]),
    );
    fallbackMocks.shouldFallbackFor.mockReturnValue(true);

    const events = await outlineEvents(resolvedModel(false));

    // Initial attempt + MAX_STREAM_RETRIES same-model retries, no fallback round.
    expect(streamLLMMock).toHaveBeenCalledTimes(3);
    expect(fallbackMocks.resolveFallbackModel).not.toHaveBeenCalled();
    expect(fallbackMocks.logFallbackFired).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('stops on a content-filter finish without retrying or falling back', async () => {
    streamLLMMock.mockImplementation(() =>
      fullStreamOf([{ type: 'finish', finishReason: 'content-filter' }]),
    );
    fallbackMocks.shouldFallbackFor.mockReturnValue(true);

    const events = await outlineEvents(resolvedModel(true));

    expect(streamLLMMock).toHaveBeenCalledTimes(1);
    expect(fallbackMocks.resolveFallbackModel).not.toHaveBeenCalled();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.error).toBe('LLM response blocked by content filter');
  });
});
