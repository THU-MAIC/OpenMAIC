import { describe, expect, it } from 'vitest';

import { getCanonicalModelId } from '@/lib/ai/model-aliases';

describe('model aliases', () => {
  it('canonicalizes GPT-5.6 Sol only for OpenAI', () => {
    expect(getCanonicalModelId('openai', 'gpt-5.6-sol')).toBe('gpt-5.6');
    expect(getCanonicalModelId('openrouter', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('leaves canonical and unrelated model IDs unchanged', () => {
    expect(getCanonicalModelId('openai', 'gpt-5.6')).toBe('gpt-5.6');
    expect(getCanonicalModelId('openai', 'gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });
});
