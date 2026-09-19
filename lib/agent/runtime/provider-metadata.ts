/** Typed pass-through of provider-specific per-tool-call metadata (e.g. Gemini
 *  thought_signature) so multi-turn tool conversations don't error. Stored on
 *  the pi ToolCall, re-emitted on the next turn's assistant message part. */
export type ToolCallProviderMetadata = Record<string, Record<string, unknown>>;

interface ToolCallPartLike {
  providerMetadata?: ToolCallProviderMetadata;
  providerOptions?: ToolCallProviderMetadata;
  // AI SDK fullStream tool-call parts carry many other fields (type, toolCallId,
  // toolName, input, ...); accept them so callers can pass a part literal.
  [key: string]: unknown;
}

/** Ingest: capture providerMetadata from an AI SDK fullStream tool-call part. */
export function captureToolCallMetadata(
  part: ToolCallPartLike,
): ToolCallProviderMetadata | undefined {
  const meta = part.providerMetadata ?? part.providerOptions;
  if (!meta || Object.keys(meta).length === 0) return undefined;
  return meta;
}

/** Egress: re-emit as providerOptions on the next turn's tool-call message part. */
export function emitToolCallProviderOptions(
  meta: ToolCallProviderMetadata | undefined,
): ToolCallProviderMetadata | undefined {
  return meta && Object.keys(meta).length > 0 ? meta : undefined;
}
