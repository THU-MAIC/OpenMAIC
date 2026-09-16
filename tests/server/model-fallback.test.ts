import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  getFallbackChain,
  isCapacityError,
  isFallbackEligible,
  nextFallbackModel,
} from '@/lib/server/model-fallback';

const resolveModel = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel }));

const ORIGINAL = process.env.MODEL_FALLBACKS;

beforeEach(() => {
  resolveModel.mockReset();
  resolveModel.mockImplementation(async ({ modelString }: { modelString: string }) => ({
    model: { provider: 'google', modelId: modelString.split(':')[1] },
  }));
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MODEL_FALLBACKS;
  else process.env.MODEL_FALLBACKS = ORIGINAL;
});

describe('getFallbackChain', () => {
  it('reads a JSON array', () => {
    process.env.MODEL_FALLBACKS = '["google:a","google:b"]';
    expect(getFallbackChain()).toEqual(['google:a', 'google:b']);
  });

  it('reads a comma-separated list, trimming spaces', () => {
    process.env.MODEL_FALLBACKS = ' google:a , google:b ';
    expect(getFallbackChain()).toEqual(['google:a', 'google:b']);
  });

  it('is empty when unset, so the feature is opt-in', () => {
    delete process.env.MODEL_FALLBACKS;
    expect(getFallbackChain()).toEqual([]);
  });

  it('ignores malformed JSON instead of throwing at call time', () => {
    process.env.MODEL_FALLBACKS = '["google:a"';
    expect(getFallbackChain()).toEqual([]);
  });

  it('drops entries with no provider prefix', () => {
    process.env.MODEL_FALLBACKS = 'google:a,gemini-3.6-flash,google:b';
    expect(getFallbackChain()).toEqual(['google:a', 'google:b']);
  });
});

describe('isCapacityError', () => {
  it('matches a bare 429', () => {
    expect(isCapacityError({ statusCode: 429 })).toBe(true);
  });

  it('matches the quota message Google actually returns', () => {
    expect(
      isCapacityError(new Error('You exceeded your current quota, please check your plan')),
    ).toBe(true);
  });

  it('matches a 503 overload, which stalls just as hard', () => {
    expect(isCapacityError({ statusCode: 503 })).toBe(true);
  });

  it('unwraps the AI SDK RetryError that hides the real status', () => {
    expect(isCapacityError({ message: 'Failed after 3 attempts', lastError: { statusCode: 429 } })).toBe(
      true,
    );
  });

  it('follows a `cause` chain too', () => {
    expect(isCapacityError({ message: 'wrapped', cause: { statusCode: 429 } })).toBe(true);
  });

  // The point of the guard: an ordinary failure must fail where it happened
  // rather than spending a second model's quota to produce the same error.
  it('does not match an ordinary error', () => {
    expect(isCapacityError(new Error('Expected exactly 1 teacher, got 2'))).toBe(false);
  });

  it('does not match auth or bad-request failures', () => {
    expect(isCapacityError({ statusCode: 401 })).toBe(false);
    expect(isCapacityError({ statusCode: 400, message: 'invalid schema' })).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const loop: { message: string; cause?: unknown } = { message: 'x' };
    loop.cause = loop;
    expect(isCapacityError(loop)).toBe(false);
  });
});

describe('isFallbackEligible', () => {
  // Falling back here would report the user's dead or mis-keyed model as
  // healthy, because a different model answered the probe.
  it('refuses to fail over a model verification probe', () => {
    expect(isFallbackEligible('verify-model')).toBe(false);
  });

  it('allows ordinary generation sources', () => {
    for (const source of ['scene-content', 'scene-actions', 'quiz-grade', 'pbl-chat']) {
      expect(isFallbackEligible(source)).toBe(true);
    }
  });
});

describe('nextFallbackModel', () => {
  it('walks the chain in order and never repeats a model', async () => {
    process.env.MODEL_FALLBACKS = 'google:a,google:b';
    const tried = new Set<string>();

    expect((await nextFallbackModel(tried))?.modelString).toBe('google:a');
    expect((await nextFallbackModel(tried))?.modelString).toBe('google:b');
    expect(await nextFallbackModel(tried)).toBeNull();
  });

  it('skips a model the caller already used', async () => {
    process.env.MODEL_FALLBACKS = 'google:a,google:b';
    const tried = new Set(['google:a']);

    expect((await nextFallbackModel(tried))?.modelString).toBe('google:b');
  });

  it('skips an unresolvable entry rather than abandoning the rest', async () => {
    process.env.MODEL_FALLBACKS = 'google:broken,google:b';
    resolveModel.mockImplementation(async ({ modelString }: { modelString: string }) => {
      if (modelString === 'google:broken') throw new Error('no API key configured');
      return { model: { provider: 'google', modelId: 'b' } };
    });

    expect((await nextFallbackModel(new Set()))?.modelString).toBe('google:b');
  });

  it('returns null when nothing is configured', async () => {
    delete process.env.MODEL_FALLBACKS;
    expect(await nextFallbackModel(new Set())).toBeNull();
  });
});
