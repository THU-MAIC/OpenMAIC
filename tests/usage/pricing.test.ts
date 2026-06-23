import { describe, expect, it } from 'vitest';
import {
  computeCost,
  resolveModelPricing,
  DEFAULT_PRICING,
  type ModelPricing,
} from '@/lib/usage/pricing';
import type { NormalizedUsage } from '@/lib/usage/normalize';

const usage: NormalizedUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheCreationTokens: 1_000_000,
  reasoningTokens: 0,
};

const pricing: ModelPricing = {
  modelId: 'test-model',
  displayName: 'Test',
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheCreationPerMillion: 3.75,
};

describe('computeCost', () => {
  it('multiplies each token class by its per-million rate', () => {
    const cost = computeCost(usage, pricing);
    expect(cost).not.toBeNull();
    expect(cost!.inputCostUsd).toBeCloseTo(3);
    expect(cost!.outputCostUsd).toBeCloseTo(15);
    expect(cost!.cacheReadCostUsd).toBeCloseTo(0.3);
    expect(cost!.cacheCreationCostUsd).toBeCloseTo(3.75);
    expect(cost!.totalCostUsd).toBeCloseTo(22.05);
  });

  it('scales sub-million token counts proportionally', () => {
    const cost = computeCost(
      { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
      pricing,
    );
    expect(cost!.inputCostUsd).toBeCloseTo(1.5);
    expect(cost!.totalCostUsd).toBeCloseTo(1.5);
  });

  it('returns null when pricing is unknown (still record tokens, no cost)', () => {
    expect(computeCost(usage, undefined)).toBeNull();
  });

  it('treats missing cache rates as 0 rather than NaN', () => {
    const partial: ModelPricing = {
      modelId: 'm',
      displayName: 'm',
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0,
      cacheCreationPerMillion: 0,
    };
    const cost = computeCost(usage, partial);
    expect(cost!.cacheReadCostUsd).toBe(0);
    expect(cost!.totalCostUsd).toBeCloseTo(3);
  });
});

describe('resolveModelPricing', () => {
  it('matches a model id exactly in a pricing table', () => {
    const table = [pricing];
    expect(resolveModelPricing('test-model', table)?.displayName).toBe('Test');
  });

  it('matches case-insensitively', () => {
    expect(resolveModelPricing('TEST-MODEL', [pricing])?.modelId).toBe('test-model');
  });

  it('returns undefined for an unknown model', () => {
    expect(resolveModelPricing('nope', [pricing])).toBeUndefined();
  });

  it('falls back to the bundled DEFAULT_PRICING when no table is given', () => {
    // DEFAULT_PRICING should contain at least one common model entry.
    expect(DEFAULT_PRICING.length).toBeGreaterThan(0);
    const anyModel = DEFAULT_PRICING[0].modelId;
    expect(resolveModelPricing(anyModel)?.modelId).toBe(anyModel);
  });
});
