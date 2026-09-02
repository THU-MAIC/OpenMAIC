/**
 * Adapters must receive an explicit model — never fall back to a hardcoded
 * vendor default. Callers (the API routes) resolve the model from the client
 * header or the server `_MODELS` config; this throws a clear error for callers
 * that bypass that resolution.
 */
export function requireModel(model: string | undefined, providerLabel: string): string {
  if (!model) {
    throw new Error(`${providerLabel} requires a model to be configured`);
  }
  return model;
}
