import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';
import {
  getDefaultThinkingConfig,
  getThinkingDisplayValue,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import type { ProviderId } from '@/lib/types/provider';

function getThinking(providerId: ProviderId, modelId: string) {
  const model = getProvider(providerId)?.models.find((item) => item.id === modelId);
  return model?.capabilities?.thinking;
}

describe('thinking config metadata', () => {
  it('marks configurable models with adapter-backed thinking capabilities', () => {
    const thinking = getThinking('qwen', 'qwen3.6-plus');

    expect(supportsConfigurableThinking(thinking)).toBe(true);
    expect(thinking?.control).toBe('toggle-budget');
    expect(thinking?.requestAdapter).toBe('qwen');
  });

  it('does not expose fixed thinking models as configurable', () => {
    const thinking = getThinking('grok', 'grok-4.20-reasoning');
    const minimaxThinking = getThinking('minimax', 'MiniMax-M2.7');

    expect(thinking?.control).toBe('none');
    expect(supportsConfigurableThinking(thinking)).toBe(false);
    expect(minimaxThinking?.control).toBe('none');
    expect(supportsConfigurableThinking(minimaxThinking)).toBe(false);
  });

  it('marks legacy models without dropping their thinking config', () => {
    const model = getProvider('openai')?.models.find((item) => item.id === 'o3-mini');

    expect(model?.lifecycle).toBe('legacy');
    expect(supportsConfigurableThinking(model?.capabilities?.thinking)).toBe(true);
  });

  it('removes deprecated Gemini 3 Pro and legacy DeepSeek aliases from the catalog', () => {
    const googleModels = getProvider('google')?.models.map((item) => item.id);
    const deepseekModels = getProvider('deepseek')?.models.map((item) => item.id);
    const hunyuanModels = getProvider('tencent-hunyuan')?.models.map((item) => item.id);

    expect(googleModels).toContain('gemini-3.1-pro-preview');
    expect(googleModels).not.toContain('gemini-3-pro-preview');
    expect(deepseekModels).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
    expect(hunyuanModels).toEqual(['hy3-preview']);
  });
});

describe('thinking config normalization', () => {
  it('normalizes OpenAI effort defaults and selected effort values', () => {
    const thinking = getThinking('openai', 'gpt-5.4');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'disabled',
      effort: 'none',
    });
    expect(normalizeThinkingConfig(thinking, { effort: 'high' })).toEqual({
      mode: 'enabled',
      effort: 'high',
    });
  });

  it('normalizes GPT-5.5 as non-toggleable effort levels', () => {
    const thinking = getThinking('openai', 'gpt-5.5');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'enabled',
      effort: 'medium',
    });
    expect(normalizeThinkingConfig(thinking, { mode: 'disabled' })).toEqual({
      mode: 'enabled',
      effort: 'low',
    });
    expect(thinking?.effortValues).toEqual(['low', 'medium', 'high']);
  });

  it('normalizes Claude 4.5+ thinking as effort levels', () => {
    const thinking = getThinking('anthropic', 'claude-sonnet-4-6');
    const opus47Thinking = getThinking('anthropic', 'claude-opus-4-7');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'enabled',
      effort: 'medium',
    });
    expect(normalizeThinkingConfig(thinking, { effort: 'max' })).toEqual({
      mode: 'enabled',
      effort: 'max',
    });
    expect(normalizeThinkingConfig(thinking, { mode: 'disabled' })).toEqual({
      mode: 'disabled',
      effort: 'none',
    });
    expect(opus47Thinking?.effortValues).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('normalizes DeepSeek V4 thinking as high/max effort levels', () => {
    const thinking = getThinking('deepseek', 'deepseek-v4-pro');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'enabled',
      effort: 'high',
    });
    expect(normalizeThinkingConfig(thinking, { effort: 'max' })).toEqual({
      mode: 'enabled',
      effort: 'max',
    });
  });

  it('normalizes Tencent HY3 thinking as no_think/low/high effort levels', () => {
    const thinking = getThinking('tencent-hunyuan', 'hy3-preview');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'disabled',
      effort: 'none',
    });
    expect(normalizeThinkingConfig(thinking, { effort: 'high' })).toEqual({
      mode: 'enabled',
      effort: 'high',
    });
    expect(thinking?.effortValues).toEqual(['none', 'low', 'high']);
  });

  it('normalizes Doubao Seed 2.0 thinking as reasoning effort levels', () => {
    const thinking = getThinking('doubao', 'doubao-seed-2-0-pro-260215');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'enabled',
      effort: 'medium',
    });
    expect(normalizeThinkingConfig(thinking, { effort: 'high' })).toEqual({
      mode: 'enabled',
      effort: 'high',
    });
    expect(thinking?.effortValues).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('preserves dynamic Gemini budgets and display labels', () => {
    const thinking = getThinking('google', 'gemini-2.5-flash');

    expect(getDefaultThinkingConfig(thinking)).toEqual({
      mode: 'enabled',
      budgetTokens: -1,
    });
    expect(getThinkingDisplayValue(thinking, undefined)).toBe('on');
    expect(getThinkingDisplayValue(thinking, { mode: 'enabled', budgetTokens: 8192 })).toBe('8192');
  });
});
