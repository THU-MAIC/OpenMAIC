import { describe, expect, it } from 'vitest';

import { findModelById, getCanonicalModelId, modelIdsMatch } from '@/lib/ai/model-aliases';
import { preservesReasoning } from '@/lib/ai/providers';

describe('model aliases', () => {
  it('canonicalizes GPT-5.6 Sol only for OpenAI', () => {
    expect(getCanonicalModelId('openai', 'gpt-5.6-sol')).toBe('gpt-5.6');
    expect(getCanonicalModelId('openrouter', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('leaves canonical and unrelated model IDs unchanged', () => {
    expect(getCanonicalModelId('openai', 'gpt-5.6')).toBe('gpt-5.6');
    expect(getCanonicalModelId('openai', 'gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });

  it('matches and finds an alias through its canonical model ID', () => {
    const models = [
      { id: 'gpt-5.6-sol', vision: false },
      { id: 'gpt-5.6', vision: true },
    ];

    expect(modelIdsMatch('openai', 'gpt-5.6', 'gpt-5.6-sol')).toBe(true);
    expect(findModelById('openai', models, 'gpt-5.6-sol')).toBe(models[1]);
    expect(findModelById('openrouter', [models[1]], 'gpt-5.6-sol')).toBeUndefined();
  });

  it('resolves retired DeepSeek Flash IDs to the current Flash model', () => {
    expect(getCanonicalModelId('deepseek', 'deepseek-v4-flash')).toBe('deepseek-flash');
    expect(getCanonicalModelId('deepseek', 'deepseek-v4-flash-vision-exp')).toBe('deepseek-flash');
    expect(getCanonicalModelId('openrouter', 'deepseek/deepseek-v4-flash')).toBe(
      'deepseek/deepseek-v4-flash',
    );
    // Tool-calling follow-ups to DeepSeek fail without replayed reasoning.
    expect(preservesReasoning('deepseek', 'deepseek-v4-flash')).toBe(true);
    expect(preservesReasoning('deepseek', 'deepseek-v4-flash-vision-exp')).toBe(true);
  });

  it('resolves other vendor-routed retired IDs to their catalog successors', () => {
    expect(getCanonicalModelId('tencent-hunyuan', 'hy3-preview')).toBe('hy3');
    expect(getCanonicalModelId('grok', 'grok-code-fast-1')).toBe('grok-build-0.1');
    expect(getCanonicalModelId('doubao', 'glm-5.2')).toBe('glm-5.3');
    expect(getCanonicalModelId('glm', 'glm-5.2')).toBe('glm-5.2');
  });
});
