import { withAbort } from '../abort';
import type { WebFetchProvider } from '../types';
import {
  KEENABLE_APP_TITLE,
  KEENABLE_DEFAULT_BASE_URL,
  isOfficialKeenableBaseUrl,
  keenableEndpoint,
} from '@/lib/web-search/keenable-endpoint';

/** Endpoint identity comes from the configured API base; a key selects the keyed endpoint. */
export function keenableFetchEndpoint(baseUrl: string, url: string, keyed: boolean): string {
  const endpoint = new URL(keenableEndpoint(baseUrl, 'fetch', keyed));
  endpoint.searchParams.set('url', url);
  return endpoint.href;
}

/**
 * Keenable Fetch (`GET /v1/fetch/public` without a key, `/v1/fetch` with one):
 * returns the page content as Markdown. It shares the `keenable` provider
 * (optional key and base URL) with Keenable web search.
 * Docs: https://docs.keenable.ai/api-reference
 */
export const keenable: Extract<WebFetchProvider, { hosted: true }> = {
  id: 'keenable',
  name: 'Keenable',
  icon: '/logos/keenable.svg',
  hosted: true,
  requiresApiKey: false,
  apiKeyOptional: true,
  defaultBaseUrl: KEENABLE_DEFAULT_BASE_URL,
  acceptsWorkspaceBaseUrl: isOfficialKeenableBaseUrl,
  resolveCredentials: (credentials = {}) => ({
    ...credentials,
    baseUrl: credentials.baseUrl ?? KEENABLE_DEFAULT_BASE_URL,
  }),
  extract: async (url, options) => {
    const credentials = keenable.resolveCredentials(options.credentials);
    const bodyTimeoutMs = options.bodyTimeoutMs ?? 30_000;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(bodyTimeoutMs)])
      : AbortSignal.timeout(bodyTimeoutMs);
    signal.throwIfAborted();
    const { Agent } = await import('undici');
    const { proxyFetch } = await import('@/lib/server/proxy-fetch');
    const agent = new Agent({
      connect: { timeout: 5_000 },
      // The page is fetched and converted before the answer, so headers arrive with the body.
      headersTimeout: bodyTimeoutMs,
      bodyTimeout: bodyTimeoutMs,
    });
    try {
      const endpoint = keenableFetchEndpoint(credentials.baseUrl!, url, !!credentials.apiKey);
      const response = await withAbort(
        proxyFetch(
          endpoint,
          {
            method: 'GET',
            redirect: 'error',
            headers: {
              Accept: 'application/json',
              'X-Keenable-Title': KEENABLE_APP_TITLE,
              ...(credentials.apiKey ? { 'X-API-Key': credentials.apiKey } : {}),
            },
            signal,
            dispatcher: agent,
          } as RequestInit & { dispatcher: typeof agent },
          {
            proxy: credentials.proxy,
            timeouts: {
              connectTimeout: 5_000,
              headersTimeout: bodyTimeoutMs,
              bodyTimeout: bodyTimeoutMs,
            },
          },
        ),
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // Do not relay vendor messages, which can echo credentials or request data.
        throw new Error(`Web fetch provider returned HTTP ${response.status}`);
      }
      const { readWithTruncation } = await import('../builtin-extraction');
      const body = await readWithTruncation(
        response,
        4 * (options.maxBytes ?? 5 * 1024 * 1024) + 65_536,
        signal,
        bodyTimeoutMs,
      );
      if (body.truncated) throw new Error('Web fetch response exceeds the transport byte limit');
      let result: unknown;
      try {
        result = JSON.parse(body.bytes.toString('utf8'));
      } catch {
        throw new Error('Invalid web fetch JSON response');
      }
      signal.throwIfAborted();
      if (!result || typeof result !== 'object') throw new Error('Invalid web fetch response');
      const data = result as Record<string, unknown>;
      if (typeof data.content !== 'string')
        throw new Error('Web fetch response has no Markdown content');
      return {
        markdown: data.content,
        ...(typeof data.title === 'string' ? { title: data.title } : {}),
        ...(typeof data.url === 'string' ? { finalUrl: data.url } : {}),
      };
    } finally {
      await agent.destroy();
    }
  },
};

export default keenable;
