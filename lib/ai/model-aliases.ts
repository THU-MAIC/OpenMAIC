const MODEL_ID_ALIASES: ReadonlyMap<string, string> = new Map([['openai:gpt-5.6-sol', 'gpt-5.6']]);

/** Resolve aliases used for local catalog, settings, capability, and usage lookups. */
export function getCanonicalModelId(providerId: string, modelId: string): string {
  return MODEL_ID_ALIASES.get(`${providerId}:${modelId}`) ?? modelId;
}
