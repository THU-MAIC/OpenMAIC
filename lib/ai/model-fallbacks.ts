/**
 * The retry model that belongs to a language model instance.
 *
 * A model resolved through a capability slot (RFC #1701) carries its slot's
 * `fallback` with it. Keyed by the instance, so every call that uses the model
 * retries on the right fallback without each call site passing it along; a
 * model with nothing attached is on the older request path.
 */
import type { LanguageModel } from 'ai';

export interface FallbackModel {
  model: LanguageModel;
  /** Canonical `provider:model`, for logs. */
  modelString: string;
}

export type FallbackLoader = () => Promise<FallbackModel | null>;

const attached = new WeakMap<object, FallbackLoader>();

/** Record `load` as the retry model of `model`; resolves to null for none. */
export function attachModelFallback(model: LanguageModel, load: FallbackLoader): void {
  if (typeof model === 'object' && model !== null) attached.set(model, load);
}

export function attachedModelFallback(model: unknown): FallbackLoader | undefined {
  return typeof model === 'object' && model !== null ? attached.get(model) : undefined;
}
