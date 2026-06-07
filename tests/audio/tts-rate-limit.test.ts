import { describe, it, expect } from 'vitest';
import { throwIfTtsRateLimited, TTSRateLimitError } from '@/lib/audio/tts-providers';

describe('throwIfTtsRateLimited', () => {
  it('throws a typed TTSRateLimitError on HTTP 429', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 429)).toThrow(TTSRateLimitError);
    try {
      throwIfTtsRateLimited('OpenAI', 429);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TTSRateLimitError);
      expect((e as TTSRateLimitError).provider).toBe('OpenAI');
    }
  });

  it('does not throw on non-429 statuses', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 200)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 401)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 500)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 503)).not.toThrow();
  });
});
