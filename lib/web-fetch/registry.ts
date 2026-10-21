import { builtin } from './providers/builtin';
import { deepseek } from './providers/deepseek';
import { firecrawl } from './providers/firecrawl';
import { kimi } from './providers/kimi';
import type { WebFetchProvider } from './types';

/** Composition root: add one provider module and one entry here, plus tests and docs. */
export const WEB_FETCH_PROVIDERS: Readonly<Record<string, WebFetchProvider>> = {
  builtin,
  kimi,
  deepseek,
  firecrawl,
};
export const DEFAULT_WEB_FETCH_PROVIDER = builtin;
export function getWebFetchProvider(id: string): WebFetchProvider | undefined {
  return Object.hasOwn(WEB_FETCH_PROVIDERS, id) ? WEB_FETCH_PROVIDERS[id] : undefined;
}

/** Serializable projection for settings; the browser never imports executable adapters. */
export function webFetchProviderMetadata() {
  return Object.values(WEB_FETCH_PROVIDERS).map(
    ({ id, name, nameKey, icon, requiresApiKey, credentialPresets }) => ({
      id,
      name,
      nameKey,
      icon,
      requiresApiKey,
      credentialPresets,
    }),
  );
}
