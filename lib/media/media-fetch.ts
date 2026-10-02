import type { MediaProviderFetch } from './types';

/**
 * The transport an adapter uses for every request to its provider: the one the
 * server caller injected (the pinned provider transport), else the global
 * `fetch`, looked up at call time.
 */
export function mediaFetchFor(config: { fetchImpl?: MediaProviderFetch }): MediaProviderFetch {
  return config.fetchImpl ?? ((input, init) => fetch(input, init));
}
