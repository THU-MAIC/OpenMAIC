import { builtin } from './providers/builtin';
import { providers } from './providers.generated';
import type { WebFetchProvider } from './types';

/** The only registration point; execution and configuration iterate this catalogue. */
export const WEB_FETCH_PROVIDERS: Readonly<Record<string, WebFetchProvider>> = Object.freeze(
  Object.fromEntries(providers.map((provider) => [provider.id, provider])),
);
export const DEFAULT_WEB_FETCH_PROVIDER = builtin;
export function getWebFetchProvider(id: string): WebFetchProvider | undefined {
  return Object.hasOwn(WEB_FETCH_PROVIDERS, id) ? WEB_FETCH_PROVIDERS[id] : undefined;
}
