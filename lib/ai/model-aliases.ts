const MODEL_ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ['openai:gpt-5.6-sol', 'gpt-5.6'],
  // Retired DeepSeek IDs that DeepSeek still routes to its current Flash model.
  // Saved configurations keep its capabilities, including reasoning replay,
  // which tool-calling follow-up requests require.
  ['deepseek:deepseek-v4-flash', 'deepseek-flash'],
  ['deepseek:deepseek-v4-flash-vision-exp', 'deepseek-flash'],
  // Other retired IDs their vendors route to a catalog successor.
  ['tencent-hunyuan:hy3-preview', 'hy3'],
  ['grok:grok-code-fast-1', 'grok-build-0.1'],
  ['doubao:glm-5.2', 'glm-5.3'],
]);

/** Resolve aliases used for local catalog, settings, capability, and usage lookups. */
export function getCanonicalModelId(providerId: string, modelId: string): string {
  return MODEL_ID_ALIASES.get(`${providerId}:${modelId}`) ?? modelId;
}

export function modelIdsMatch(providerId: string, left: string, right: string): boolean {
  return getCanonicalModelId(providerId, left) === getCanonicalModelId(providerId, right);
}

/** Find a model using canonical IDs without changing the model ID sent on the wire. */
export function findModelById<T extends { id: string }>(
  providerId: string,
  models: readonly T[] | undefined,
  modelId: string,
): T | undefined {
  const canonicalModelId = getCanonicalModelId(providerId, modelId);
  return (
    models?.find((model) => model.id === canonicalModelId) ??
    models?.find((model) => modelIdsMatch(providerId, model.id, modelId))
  );
}
