/**
 * The outline step retries its stream itself; a failure the host classifies
 * as one no retry helps ends the step at once, with the host's own error (so
 * the run reports the host's code), instead of after every retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@/lib/logger';
import {
  configureGenerationRunHooks,
  resetGenerationRunHooksForTests,
} from '@/lib/server/generation-run-hooks/registry';

const streamLLMMock = vi.fn();
vi.mock('@/lib/ai/llm', () => ({
  streamLLM: (...args: unknown[]) => streamLLMMock(...args),
}));
vi.mock('@/lib/server/llm-fallback', () => ({
  resolveFallbackModel: vi.fn(),
  shouldFallbackFor: () => false,
  logFallbackFired: vi.fn(),
}));

import { generateOutlines } from '@/lib/server/generation/steps/outline';

class QuotaError extends Error {
  constructor() {
    super('The quota is used up');
    this.name = 'QuotaError';
  }
}

async function outline(): Promise<unknown> {
  try {
    await generateOutlines(
      {
        requirements: { requirement: 'Teach photosynthesis' },
        model: {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' },
          modelInfo: { capabilities: {} },
          modelString: 'openai:gpt-5.4',
          thinkingConfig: undefined,
          serverManaged: true,
        } as never,
      },
      {
        log: createLogger('Outline'),
        workspaceId: null,
        resolveVisionImages: async (images) => [...images],
        emit: () => undefined,
      },
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

const errorPart = () => ({
  fullStream: (async function* () {
    yield { type: 'error', error: new QuotaError() };
  })(),
});
const throwing = () => ({
  fullStream: (async function* () {
    throw new QuotaError();
  })(),
});

/** Some outline streamed, then the stream failed. */
const partialThenError = () => ({
  fullStream: (async function* () {
    yield {
      type: 'text-delta',
      text: '{"languageDirective":"English","outlines":[{"title":"Intro"}]}',
    };
    yield { type: 'error', error: new QuotaError() };
  })(),
});

describe('the outline step and a host failure', () => {
  beforeEach(() => {
    resetGenerationRunHooksForTests();
    streamLLMMock.mockReset();
  });
  afterEach(() => resetGenerationRunHooksForTests());

  it('retries it as any failure without a classification', async () => {
    streamLLMMock.mockImplementation(errorPart);
    expect(await outline()).toMatchObject({ message: 'The quota is used up' });
    expect(streamLLMMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an error part', errorPart],
    ['a throw', throwing],
  ])('stops at the first attempt on %s the host says no retry helps', async (_label, stream) => {
    configureGenerationRunHooks({
      name: 'h',
      classifyFailure: (error) =>
        error instanceof QuotaError
          ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false }
          : undefined,
    });
    streamLLMMock.mockImplementation(stream);
    expect(await outline()).toBeInstanceOf(QuotaError);
    expect(streamLLMMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the outlines that streamed before a failure without a classification', async () => {
    streamLLMMock.mockImplementation(partialThenError);
    expect(await outline()).toBeUndefined();
    expect(streamLLMMock).toHaveBeenCalledTimes(1);
  });

  it('fails on a host failure no retry helps, even after some outlines streamed', async () => {
    configureGenerationRunHooks({
      name: 'h',
      classifyFailure: (error) =>
        error instanceof QuotaError
          ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false }
          : undefined,
    });
    streamLLMMock.mockImplementation(partialThenError);
    expect(await outline()).toBeInstanceOf(QuotaError);
    expect(streamLLMMock).toHaveBeenCalledTimes(1);
  });
});
