import type { Api, Context, Model } from '@earendil-works/pi-ai';

/** UTF-8 bytes are a conservative token upper estimate, not a tokenizer or usage meter.
 * Count the complete payload when provider usage is absent, with protocol headroom.
 * Never assume Chinese text occupies four characters per token.
 */
export const contextBytes = (value: unknown): number =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));

export function estimatedRequestTokens(context: Context): number {
  return (
    contextBytes(context.systemPrompt ?? '') +
    contextBytes(context.tools ?? []) +
    contextBytes(context.messages) +
    512
  );
}

/** Input reservation shared with transport only for a confirmed output window.
 * Unknown output capacity uses an estimate here; it must not become a wire cap.
 */
export function teachingModelBudget(model: Model<Api>) {
  const contextWindow =
    Number.isFinite(model.contextWindow) && model.contextWindow > 0
      ? Math.floor(model.contextWindow)
      : 128_000;
  const knownOutput =
    Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : 8192;
  const outputTokens = Math.max(1, Math.min(knownOutput, Math.floor(contextWindow / 4)));
  return {
    contextWindow,
    outputTokens,
    inputTokens: Math.floor(contextWindow * 0.9) - outputTokens,
  };
}
