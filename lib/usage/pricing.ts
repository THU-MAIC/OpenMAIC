import type { NormalizedUsage } from './normalize';
import defaults from './pricing-defaults.json';

/**
 * Per-model pricing in USD per million tokens, split into the four billable
 * classes (mirrors cc-switch `model_pricing`). Cache rates default to 0 when a
 * provider/model has no separate cache pricing.
 */
export interface ModelPricing {
  modelId: string;
  displayName: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreationPerMillion: number;
}

/** Cost breakdown in USD for one request. */
export interface CostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheCreationCostUsd: number;
  totalCostUsd: number;
}

/**
 * Bundled default pricing table covering models commonly exposed by MAIC-style
 * gateways. Operators can override/extend this in the UI; models.dev import is a
 * future enhancement. Keep this as the offline fallback.
 */
export const DEFAULT_PRICING: ModelPricing[] = defaults as ModelPricing[];

function rate(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Finds pricing for a model id (case-insensitive exact match). Falls back to the
 * bundled `DEFAULT_PRICING` when no table is supplied. Returns undefined when the
 * model is unknown — callers should still record token counts with a null cost.
 */
export function resolveModelPricing(
  modelId: string,
  table: ModelPricing[] = DEFAULT_PRICING,
): ModelPricing | undefined {
  const target = modelId.toLowerCase();
  return table.find((p) => p.modelId.toLowerCase() === target);
}

/**
 * Computes the USD cost for a request from normalized usage and a pricing row.
 * Each token class is billed at `tokens / 1_000_000 * ratePerMillion`. Returns
 * null when pricing is unknown, signalling "record tokens, no cost".
 */
export function computeCost(
  usage: NormalizedUsage,
  pricing: ModelPricing | undefined,
): CostBreakdown | null {
  if (!pricing) return null;

  const inputCostUsd = (usage.inputTokens / 1_000_000) * rate(pricing.inputPerMillion);
  const outputCostUsd = (usage.outputTokens / 1_000_000) * rate(pricing.outputPerMillion);
  const cacheReadCostUsd =
    (usage.cacheReadTokens / 1_000_000) * rate(pricing.cacheReadPerMillion);
  const cacheCreationCostUsd =
    (usage.cacheCreationTokens / 1_000_000) * rate(pricing.cacheCreationPerMillion);

  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheCreationCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheCreationCostUsd,
  };
}
